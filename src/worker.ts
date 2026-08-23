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
import type { ChildMessage, ParentMessage } from './protocol.js';
import { configureStorage, openDataset } from './storage.js';
import type { ActorContext, ActorRunFn } from './types.js';

function send(message: ChildMessage): void {
    process.send?.(message);
}

/** Flushes the final message before exiting, which process.exit alone does not. */
function finish(message: ChildMessage, code: number): void {
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

process.on('message', (message: ParentMessage) => {
    if (message.type === 'abort') controller.abort();
    else if (message.type === 'run') void execute(message);
});

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
        };

        const run = await loadRunFn(job.actorDir, job.actorName);
        await run(job.input, ctx);
        finish({ type: 'done' }, 0);
    } catch (err) {
        finish({ type: 'error', message: err instanceof Error ? err.message : String(err) }, 1);
    }
}

send({ type: 'ready' });
