import { randomUUID } from 'node:crypto';
import type { ActorContext, ActorManifest, RunRecord, RunStatus } from './types.js';
import { isTerminal } from './types.js';
import { loadActorRunFn } from './registry.js';
import { openDataset, openKeyValueStore } from './storage.js';
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
}

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
    private readonly controllers = new Map<string, AbortController>();
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
        const controller = this.controllers.get(runId);
        if (!record || !controller || controller.signal.aborted) return false;

        record.status = 'ABORTING';
        controller.abort();
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

        const dataset = await openDataset(id);
        const controller = new AbortController();
        this.controllers.set(id, controller);

        const ctx: ActorContext = {
            runId: id,
            pushData: async (item) => {
                const items = Array.isArray(item) ? item : [item];
                if (items.length === 0) return;
                await dataset.pushData(items);
                record.itemCount += items.length;
            },
            log: (message) => {
                if (record.log.length >= MAX_LOG_LINES) record.log.shift();
                record.log.push(`${new Date().toISOString()} ${message}`);
            },
            signal: controller.signal,
        };

        // Distinguishes "the clock ran out" from "someone stopped it", which
        // are different diagnoses and were previously reported identically.
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            record.status = 'TIMING-OUT';
            controller.abort();
        }, timeoutSecs * 1000);

        record.status = 'RUNNING';

        try {
            const run = await loadActorRunFn(manifest);
            await run(input, ctx);

            record.status = timedOut ? 'TIMED-OUT' : controller.signal.aborted ? 'ABORTED' : 'SUCCEEDED';
            if (timedOut) record.errorMessage = `exceeded its ${timeoutSecs}s time limit`;
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (timedOut) {
                record.status = 'TIMED-OUT';
                record.errorMessage = `exceeded its ${timeoutSecs}s time limit: ${message}`;
            } else if (controller.signal.aborted) {
                record.status = 'ABORTED';
                record.errorMessage = message;
            } else {
                record.status = 'FAILED';
                record.errorMessage = message;
            }
            ctx.log(`ERROR ${message}`);
        } finally {
            clearTimeout(timer);
            this.controllers.delete(id);
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
