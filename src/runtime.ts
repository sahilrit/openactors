import { randomUUID } from 'node:crypto';
import type { ActorManifest, RunRecord, RunStatus } from './types.js';
import { isTerminal } from './types.js';
import { spawnActor, type SpawnHandle, type SpawnOutcome } from './spawn.js';
import { openKeyValueStore } from './storage.js';
import { validateInput } from './validate.js';
import { emitRunEvent, type RunEvent } from './webhooks.js';

/** Log lines held per run. Bounds memory on a chatty or runaway Actor. */
const MAX_LOG_LINES = 500;

/**
 * Runs kept in the persisted history. Old records are cheap but not free, and
 * the datasets they point at are what actually matter — those are never pruned.
 */
const MAX_PERSISTED_RUNS = 500;

const RUN_STORE = 'runs';
const RUN_KEY = 'history';

export class ActorInputError extends Error {
    constructor(
        readonly actorName: string,
        readonly errors: string[],
    ) {
        super(`Invalid input for "${actorName}": ${errors.join('; ')}`);
        this.name = 'ActorInputError';
    }
}

export interface CallOptions {
    timeoutSecs?: number;
    origin?: RunRecord['origin'];
    resurrectedFrom?: string;
    /** Heap ceiling for the Actor process. */
    memoryMbytes?: number;
}

/** Maps a worker outcome onto the run state a caller sees. */
const OUTCOME_STATUS: Record<SpawnOutcome, RunStatus> = {
    done: 'SUCCEEDED',
    error: 'FAILED',
    timeout: 'TIMED-OUT',
    aborted: 'ABORTED',
    crashed: 'FAILED',
};

/**
 * Tracks Actor runs.
 *
 * Run records are persisted, not merely held in memory: a scheduled digest, a
 * REST caller and an MCP client are separate processes, and a run started by
 * one has to be inspectable by the others and to survive a restart. The scraped
 * items live in Crawlee datasets, which were always durable; this makes the
 * metadata pointing at them durable too.
 */
export class Runtime {
    private readonly runs = new Map<string, RunRecord>();
    private readonly handles = new Map<string, SpawnHandle>();
    private loaded = false;

    /** Reads persisted history. Safe to call repeatedly; only the first reads. */
    async load(): Promise<void> {
        if (this.loaded) return;
        this.loaded = true;

        const store = await openKeyValueStore(RUN_STORE);
        const history = (await store.getValue<RunRecord[]>(RUN_KEY)) ?? [];

        for (const record of history) {
            // A run left RUNNING is one whose process died. Nothing is going to
            // finish it, and leaving it RUNNING would make it look live forever.
            if (!isTerminal(record.status)) {
                record.status = 'FAILED';
                record.errorMessage ??= 'interrupted — the server stopped while this run was in progress';
                record.finishedAt ??= new Date().toISOString();
            }
            this.runs.set(record.id, record);
        }
    }

    private async persist(): Promise<void> {
        const store = await openKeyValueStore(RUN_STORE);
        const history = [...this.runs.values()]
            .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
            .slice(0, MAX_PERSISTED_RUNS);
        await store.setValue(RUN_KEY, history);
    }

    getRun(runId: string): RunRecord | undefined {
        return this.runs.get(runId);
    }

    listRuns(limit = 50, actorName?: string, status?: RunStatus): RunRecord[] {
        return [...this.runs.values()]
            .filter((r) => (actorName ? r.actorName === actorName : true))
            .filter((r) => (status ? r.status === status : true))
            .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
            .slice(0, limit);
    }

    /**
     * Signals a run to stop. Returns false if it is not running.
     *
     * The record moves to ABORTING rather than ABORTED: the Actor stops at its
     * next checkpoint, which may be seconds away, and reporting it already
     * stopped would be a lie a poller could act on.
     */
    abort(runId: string): boolean {
        const record = this.runs.get(runId);
        const handle = this.handles.get(runId);
        if (!record || !handle || isTerminal(record.status)) return false;

        record.status = 'ABORTING';
        handle.abort();
        return true;
    }

    async call(manifest: ActorManifest, rawInput: unknown, options: CallOptions = {}): Promise<RunRecord> {
        await this.load();

        if (manifest.gatedReason) {
            throw new Error(`Actor "${manifest.name}" is not runnable: ${manifest.gatedReason}`);
        }

        // Validated before anything is allocated, so bad input costs nothing
        // and never produces a half-populated dataset.
        const validation = validateInput(manifest.name, manifest.input, rawInput);
        if (!validation.valid) throw new ActorInputError(manifest.name, validation.errors);
        const input = validation.value;

        const timeoutSecs = options.timeoutSecs ?? 300;
        const id = `run-${Date.now()}-${randomUUID().slice(0, 8)}`;
        const startedAt = Date.now();

        const record: RunRecord = {
            id,
            actorName: manifest.name,
            status: 'READY',
            startedAt: new Date(startedAt).toISOString(),
            defaultDatasetId: id,
            itemCount: 0,
            input,
            timeoutSecs,
            origin: options.origin ?? 'API',
            ...(options.resurrectedFrom ? { resurrectedFrom: options.resurrectedFrom } : {}),
            log: [],
        };
        this.runs.set(id, record);
        void this.emit('ACTOR.RUN.CREATED', record);

        // The Actor runs in its own process. The parent never imports Actor
        // code, so a crash, an out-of-memory kill, or a synchronous loop that
        // no AbortController could interrupt ends the child alone rather than
        // taking down the MCP server and the scheduler that depend on it.
        const handle = spawnActor({
            actorDir: manifest.dir,
            actorName: manifest.name,
            runId: id,
            input,
            timeoutMs: timeoutSecs * 1000,
            memoryMb: options.memoryMbytes,
            onLog: (message) => {
                if (record.log.length >= MAX_LOG_LINES) record.log.shift();
                record.log.push(`${new Date().toISOString()} ${message}`);
            },
            onItems: (count) => {
                record.itemCount += count;
            },
        });
        this.handles.set(id, handle);

        record.status = 'RUNNING';

        try {
            const outcome = await handle.result;
            record.status = OUTCOME_STATUS[outcome.outcome];

            if (outcome.outcome === 'timeout') {
                record.errorMessage = `exceeded its ${timeoutSecs}s time limit`;
            } else if (outcome.message) {
                record.errorMessage = outcome.message;
            }

            // The child counted what it actually wrote; trust that over the
            // parent's running tally, which a killed child can leave stale.
            record.itemCount = outcome.itemCount;
        } finally {
            this.handles.delete(id);
            record.finishedAt = new Date().toISOString();
            record.durationMs = Date.now() - startedAt;
            await this.persist();
        }

        void this.emit(`ACTOR.RUN.${record.status.replace('-', '_')}` as RunEvent, record);
        return record;
    }

    /**
     * Re-runs a finished run with the same Actor and input, optionally with a
     * longer timeout — the usual reason a run needs resurrecting.
     *
     * A new run is created rather than the old one being reopened, so the
     * original's dataset and diagnosis stay intact for comparison.
     */
    async resurrect(
        runId: string,
        resolve: (actorName: string) => ActorManifest | undefined,
        timeoutSecs?: number,
    ): Promise<RunRecord> {
        await this.load();

        const original = this.runs.get(runId);
        if (!original) throw new Error(`Run "${runId}" not found.`);
        if (!isTerminal(original.status)) {
            throw new Error(`Run "${runId}" is still ${original.status}; only a finished run can be resurrected.`);
        }

        const manifest = resolve(original.actorName);
        if (!manifest) throw new Error(`Actor "${original.actorName}" is no longer installed.`);

        const record = await this.call(manifest, original.input, {
            timeoutSecs: timeoutSecs ?? original.timeoutSecs,
            origin: 'RESURRECTION',
            resurrectedFrom: runId,
        });
        void this.emit('ACTOR.RUN.RESURRECTED', record);
        return record;
    }

    private async emit(event: RunEvent, record: RunRecord): Promise<void> {
        try {
            await emitRunEvent(event, record);
        } catch (err) {
            // A webhook failure must never change a run's outcome.
            record.log.push(`${new Date().toISOString()} webhook for ${event} failed: ${(err as Error).message}`);
        }
    }
}
