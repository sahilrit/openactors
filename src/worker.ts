#!/usr/bin/env node
/**
 * Runs one Actor in its own process, then exits.
 *
 * Isolation is the point. In-process, an Actor that throws from a stray
 * callback, exhausts memory, or spins synchronously takes the MCP server —
 * and the scheduler depending on it — down with it. None of those are
 * hypothetical for scraper code driving browsers and parsing hostile HTML.
 *
 * A synchronous busy loop is the case that settles the design: no
 * AbortController can interrupt it, because it never yields. Only killing the
 * process works, and only a separate process can be killed.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { ChildMessage, ParentMessage } from './protocol.js';
import { startExternal } from './external.js';
import { configureStorage, openDataset } from './storage.js';
import type { ActorContext, ActorRunFn, NestedRunResult } from './types.js';

function send(message: ChildMessage): void {
    process.send?.(message);
}

/** Reports what this process consumed, measured from inside it. */
function reportMetrics(): void {
    const cpu = process.cpuUsage();
    send({
        // rss over heapUsed: the browser and parser buffers an Actor uses live
        // outside the JS heap, and heap alone would understate a crawl badly.
        type: 'metrics',
        peakMemoryMb: Math.round((process.memoryUsage().rss / 1_048_576) * 10) / 10,
        cpuMs: Math.round((cpu.user + cpu.system) / 1000),
    });
}

/** Flushes the final message before exiting, which process.exit alone does not. */
function finish(message: ChildMessage, code: number): void {
    reportMetrics();
    if (!process.send) {
        process.exitCode = code;
        return;
    }
    process.send(message, () => process.exit(code));
    // If the channel is already gone the callback never fires; do not hang.
    setTimeout(() => process.exit(code), 2000).unref();
}

async function loadRunFn(dir: string, actorName: string): Promise<ActorRunFn> {
    const entry = ['main.ts', 'main.js'].map((f) => join(dir, f)).find((f) => existsSync(f));
    if (!entry) throw new Error(`Actor "${actorName}" has no main.ts or main.js in ${dir}`);

    const mod = await import(pathToFileURL(entry).href);
    const run = mod.run ?? mod.default;
    if (typeof run !== 'function') {
        throw new Error(`Actor "${actorName}" does not export a run() function from ${entry}`);
    }
    return run as ActorRunFn;
}

const controller = new AbortController();

/** Nested calls awaiting a reply from the parent, keyed by request id. */
const pendingCalls = new Map<string, (result: Extract<ParentMessage, { type: 'callResult' }>) => void>();

process.on('message', (message: ParentMessage) => {
    if (message.type === 'abort') controller.abort();
    else if (message.type === 'run') void execute(message);
    else if (message.type === 'callResult') pendingCalls.get(message.callId)?.(message);
});

/**
 * Runs another Actor by asking the parent to do it.
 *
 * The child has no Runtime and should not: routing through the parent means a
 * nested run gets the same input validation, concurrency limit and process
 * isolation as any other, instead of a second execution path with its own
 * rules.
 */
function makeCall(runId: string) {
    return async (actor: string, input: Record<string, unknown> = {}): Promise<NestedRunResult> => {
        const callId = `${runId}-call-${randomUUID().slice(0, 8)}`;

        const reply = await new Promise<Extract<ParentMessage, { type: 'callResult' }>>((resolve, reject) => {
            if (!process.send) {
                reject(new Error('nested calls need an IPC channel; this Actor is not running under the server'));
                return;
            }
            pendingCalls.set(callId, resolve);
            // An aborted parent run must not leave the Actor waiting forever.
            controller.signal.addEventListener('abort', () => reject(new Error('aborted while awaiting a nested call')), {
                once: true,
            });
            send({ type: 'call', callId, actor, input });
        }).finally(() => pendingCalls.delete(callId));

        if (!reply.ok) throw new Error(reply.error ?? `nested call to "${actor}" failed`);

        // A nested run that did not succeed throws in the caller. Returning it
        // quietly would let an Actor build results on top of a run that
        // produced nothing, and report success for both.
        if (reply.status !== 'SUCCEEDED') {
            throw new Error(
                `nested Actor "${actor}" finished ${reply.status}${reply.error ? `: ${reply.error}` : ''}`,
            );
        }

        const dataset = await openDataset(reply.datasetId!);
        const { items } = await dataset.getData({ limit: 10_000 });
        return {
            runId: reply.runId!,
            datasetId: reply.datasetId!,
            status: reply.status!,
            itemCount: reply.itemCount ?? items.length,
            items: items as Record<string, unknown>[],
        };
    };
}

// An Actor that throws asynchronously would otherwise take the process down
// with a bare stack trace and no run record. Report it as a run failure.
process.on('uncaughtException', (err) => {
    finish({ type: 'error', message: `uncaught exception: ${err.message}` }, 1);
});
process.on('unhandledRejection', (reason) => {
    finish({ type: 'error', message: `unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}` }, 1);
});

async function execute(job: Extract<ParentMessage, { type: 'run' }>): Promise<void> {
    try {
        configureStorage();
        const dataset = await openDataset(job.runId);

        const ctx: ActorContext = {
            runId: job.runId,
            pushData: async (item) => {
                const items = Array.isArray(item) ? item : [item];
                if (items.length === 0) return;
                // The child owns this dataset, so it writes directly rather
                // than shipping every scraped row through the IPC channel.
                await dataset.pushData(items);
                send({ type: 'items', count: items.length });
            },
            log: (message) => send({ type: 'log', message }),
            signal: controller.signal,
            call: makeCall(job.runId),
        };

        const runtime = job.runtime ?? 'node';

        if (runtime !== 'node') {
            await runExternal(job, ctx, runtime);
            return;
        }

        const run = await loadRunFn(job.actorDir, job.actorName);
        await run(job.input, ctx);
        finish({ type: 'done' }, 0);
    } catch (err) {
        finish({ type: 'error', message: err instanceof Error ? err.message : String(err) }, 1);
    }
}

/**
 * Runs an Actor written in another language, still inside this isolated
 * process — so it inherits the same timeout, memory ceiling and kill
 * behaviour as a native one, and the parent stays out of its way entirely.
 */
async function runExternal(
    job: Extract<ParentMessage, { type: 'run' }>,
    ctx: ActorContext,
    runtime: Exclude<import('./types.js').ActorRuntime, 'node'>,
): Promise<void> {
    const pending: Promise<void>[] = [];

    const { child, done } = startExternal(
        runtime,
        job.actorDir,
        job.input,
        { OPENACTORS_RUN_ID: job.runId, OPENACTORS_INPUT: JSON.stringify(job.input ?? {}) },
        {
            onItem: (item) => {
                // Writes are queued rather than awaited inline: stdout arrives
                // faster than the dataset can be written, and blocking the
                // stream would stall the child's output pipe.
                pending.push(ctx.pushData(item));
            },
            onLog: (message) => ctx.log(message),
        },
    );

    // An abort must reach the grandchild too, or killing the worker would
    // orphan the process actually doing the work.
    ctx.signal.addEventListener('abort', () => child.kill('SIGTERM'), { once: true });

    const { code, signal } = await done;
    await Promise.allSettled(pending);

    if (code === 0) return finish({ type: 'done' }, 0);
    finish(
        { type: 'error', message: `Actor process exited with ${signal ? `signal ${signal}` : `code ${code}`}` },
        1,
    );
}

send({ type: 'ready' });
