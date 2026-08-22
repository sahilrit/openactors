import { randomUUID } from 'node:crypto';
import type { ActorContext, ActorManifest, RunRecord } from './types.js';
import { loadActorRunFn } from './registry.js';
import { openDataset } from './storage.js';

/** Log lines held per run. Bounds memory on a chatty or runaway Actor. */
const MAX_LOG_LINES = 500;

/**
 * Tracks Actor runs for the life of the process. Run records are in-memory
 * while the *results* are on disk in Crawlee datasets — so a restart loses the
 * run history but never the scraped data, which is the part worth keeping.
 */
export class Runtime {
    private readonly runs = new Map<string, RunRecord>();
    private readonly controllers = new Map<string, AbortController>();

    getRun(runId: string): RunRecord | undefined {
        return this.runs.get(runId);
    }

    listRuns(limit = 50): RunRecord[] {
        return [...this.runs.values()]
            .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
            .slice(0, limit);
    }

    abort(runId: string): boolean {
        const controller = this.controllers.get(runId);
        if (!controller || controller.signal.aborted) return false;
        controller.abort();
        return true;
    }

    /**
     * Runs an Actor to completion and returns its run record.
     *
     * A failing Actor is not an exception here: the run is recorded as FAILED
     * with the message attached, and whatever it managed to push before dying
     * stays in the dataset. Callers get a partial result plus a reason instead
     * of a stack trace and nothing.
     */
    async call(manifest: ActorManifest, input: unknown, timeoutMs: number): Promise<RunRecord> {
        if (manifest.gatedReason) {
            throw new Error(`Actor "${manifest.name}" is not runnable: ${manifest.gatedReason}`);
        }

        const id = `run-${Date.now()}-${randomUUID().slice(0, 8)}`;
        const dataset = await openDataset(id);
        const controller = new AbortController();

        const record: RunRecord = {
            id,
            actorName: manifest.name,
            status: 'RUNNING',
            startedAt: new Date().toISOString(),
            defaultDatasetId: id,
            itemCount: 0,
            input,
            log: [],
        };
        this.runs.set(id, record);
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

        const timeout = setTimeout(() => controller.abort(), timeoutMs);

        try {
            const run = await loadActorRunFn(manifest);
            await run(input, ctx);
            record.status = controller.signal.aborted ? 'ABORTED' : 'SUCCEEDED';
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (controller.signal.aborted) {
                record.status = 'ABORTED';
                record.errorMessage = `Aborted after ${timeoutMs}ms: ${message}`;
            } else {
                record.status = 'FAILED';
                record.errorMessage = message;
            }
            ctx.log(`ERROR ${message}`);
        } finally {
            clearTimeout(timeout);
            this.controllers.delete(id);
            record.finishedAt = new Date().toISOString();
        }

        return record;
    }
}
