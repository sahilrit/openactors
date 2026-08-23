import { fork, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { ChildMessage, ParentMessage } from './protocol.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Seconds an aborted Actor gets to stop cleanly before it is killed outright. */
const DEFAULT_GRACE_MS = 5_000;

/** Default heap ceiling for an Actor process. */
const DEFAULT_MEMORY_MB = 2048;

export type SpawnOutcome = 'done' | 'error' | 'timeout' | 'aborted' | 'crashed';

export interface SpawnResult {
    outcome: SpawnOutcome;
    message?: string;
    itemCount: number;
}

export interface SpawnOptions {
    actorDir: string;
    actorName: string;
    runId: string;
    input: unknown;
    runtime?: import('./types.js').ActorRuntime;
    timeoutMs: number;
    memoryMb?: number;
    graceMs?: number;
    onLog(message: string): void;
    onItems(count: number): void;
    onMetrics?(metrics: { peakMemoryMb: number; cpuMs: number }): void;
    /** Services an Actor's request to run another Actor. */
    onCall?(actor: string, input: unknown): Promise<{
        ok: boolean;
        error?: string;
        runId?: string;
        datasetId?: string;
        status?: string;
        itemCount?: number;
    }>;
}

export interface SpawnHandle {
    result: Promise<SpawnResult>;
    /** Asks the Actor to stop, escalating to a kill if it does not. */
    abort(): void;
}

/**
 * Resolves the worker entry point. A build has `worker.js`; source has `worker.ts`.
 */
function workerPath(): string {
    const candidates = ['worker.js', 'worker.ts'].map((f) => join(HERE, f));
    const found = candidates.find((f) => existsSync(f));
    if (!found) throw new Error(`worker entry point not found beside ${HERE}`);
    return found;
}

/**
 * Builds the child's Node arguments.
 *
 * A TypeScript worker needs a loader, and inheriting the parent's execArgv is
 * not enough to get one: it carries tsx only when the parent itself was
 * started by tsx. Under vitest, or any other runner with its own transform
 * pipeline, the child would inherit nothing and die trying to parse TypeScript.
 * So the loader is resolved explicitly whenever the worker is a .ts file.
 */
function childExecArgv(worker: string, memoryMb: number): string[] {
    const args = [`--max-old-space-size=${memoryMb}`];
    if (!worker.endsWith('.ts')) return args;

    try {
        const require = createRequire(import.meta.url);
        const tsxDist = dirname(require.resolve('tsx/package.json'));
        const preflight = join(tsxDist, 'dist', 'preflight.cjs');
        const loader = join(tsxDist, 'dist', 'loader.mjs');

        if (existsSync(preflight)) args.push('--require', preflight);
        if (existsSync(loader)) args.push('--import', pathToFileURL(loader).href);
    } catch {
        // Fall back to whatever the parent was given; better than nothing, and
        // the child's startup error will name the real problem if it fails.
        return [...process.execArgv, ...args];
    }

    return args;
}

/**
 * Runs an Actor in a child process.
 *
 * The parent never imports Actor code, so a crash, an out-of-memory kill, or a
 * synchronous infinite loop ends the child alone. That last case is why this
 * cannot be done with an AbortController in-process: code that never yields
 * cannot be interrupted, only killed.
 */
export function spawnActor(options: SpawnOptions): SpawnHandle {
    const { actorDir, actorName, runId, input, timeoutMs } = options;
    const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
    const memoryMb = options.memoryMb ?? DEFAULT_MEMORY_MB;

    let child: ChildProcess;
    let settled = false;
    let itemCount = 0;
    let reported: { outcome: SpawnOutcome; message?: string } | null = null;
    let intent: 'timeout' | 'aborted' | null = null;
    /** Kept so a worker that dies before reporting can still say why. */
    let lastStderr = '';
    let killTimer: NodeJS.Timeout | undefined;
    let timeoutTimer: NodeJS.Timeout | undefined;

    const result = new Promise<SpawnResult>((resolve) => {
        const finish = (outcome: SpawnOutcome, message?: string) => {
            if (settled) return;
            settled = true;
            clearTimeout(killTimer);
            clearTimeout(timeoutTimer);
            resolve({ outcome, message, itemCount });
        };

        try {
            const worker = workerPath();
            child = fork(worker, [], {
                execArgv: childExecArgv(worker, memoryMb),
                stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
                env: process.env,
            });
        } catch (err) {
            finish('crashed', `could not start worker: ${(err as Error).message}`);
            return;
        }

        // An Actor's stray console output is captured as log lines rather than
        // being interleaved into the parent's stdout, which for the MCP server
        // is the protocol channel and must stay clean.
        const relay = (prefix: string) => (chunk: Buffer) => {
            for (const line of chunk.toString('utf8').split('\n')) {
                if (line.trim() !== '') options.onLog(`${prefix} ${line}`);
            }
        };
        child.stdout?.on('data', relay('[stdout]'));
        child.stderr?.on('data', (chunk: Buffer) => {
            lastStderr = chunk.toString('utf8').trim().split('\n').slice(-3).join(' ').slice(0, 400);
            relay('[stderr]')(chunk);
        });

        child.on('message', (message: ChildMessage) => {
            switch (message.type) {
                case 'log':
                    options.onLog(message.message);
                    break;
                case 'items':
                    itemCount += message.count;
                    options.onItems(message.count);
                    break;
                case 'done':
                    reported = { outcome: 'done' };
                    break;
                case 'error':
                    reported = { outcome: 'error', message: message.message };
                    break;
                case 'metrics':
                    options.onMetrics?.({ peakMemoryMb: message.peakMemoryMb, cpuMs: message.cpuMs });
                    break;
                case 'call': {
                    const respond = (payload: Omit<Extract<ParentMessage, { type: 'callResult' }>, 'type' | 'callId'>) => {
                        // The child is blocked waiting; a failure to reply would
                        // hang it until the timeout rather than surfacing an error.
                        try {
                            child.send({ type: 'callResult', callId: message.callId, ...payload });
                        } catch {
                            /* channel closed; the run is ending anyway */
                        }
                    };
                    if (!options.onCall) {
                        respond({ ok: false, error: 'nested Actor calls are not enabled here' });
                        break;
                    }
                    void options
                        .onCall(message.actor, message.input)
                        .then(respond)
                        .catch((err: Error) => respond({ ok: false, error: err.message }));
                    break;
                }
            }
        });

        child.on('error', (err) => finish('crashed', `worker error: ${err.message}`));

        child.on('exit', (code, signal) => {
            // Intent wins over the exit code: a killed process reports SIGKILL,
            // which says how it died, not why.
            if (intent === 'timeout') return finish('timeout');
            if (intent === 'aborted') return finish('aborted');
            if (reported) return finish(reported.outcome, reported.message);

            // No message and a non-zero exit means the process died without
            // getting to report — a segfault, an OOM kill, or process.exit().
            if (signal === 'SIGKILL' || code === null) {
                return finish('crashed', `worker was killed (${signal ?? 'unknown signal'}) — most likely out of memory`);
            }
            if (code !== 0) {
                return finish(
                    'crashed',
                    `worker exited with code ${code} without reporting a result${lastStderr ? `: ${lastStderr}` : ''}`,
                );
            }
            finish('done');
        });

        const job: ParentMessage = { type: 'run', actorDir, actorName, runId, input, runtime: options.runtime };
        child.send(job, (err) => {
            if (err) finish('crashed', `could not send the job to the worker: ${err.message}`);
        });

        timeoutTimer = setTimeout(() => stop('timeout'), timeoutMs);
    });

    /** Asks the child to stop, then kills it if it does not comply in time. */
    function stop(reason: 'timeout' | 'aborted'): void {
        if (settled || intent !== null) return;
        intent = reason;

        try {
            child.send({ type: 'abort' } satisfies ParentMessage);
        } catch {
            // Channel already closed; the kill below still applies.
        }

        killTimer = setTimeout(() => {
            // SIGKILL, not SIGTERM: the grace period has already passed, and a
            // process ignoring the abort is exactly the one a catchable signal
            // will not stop either.
            if (!settled) child.kill('SIGKILL');
        }, graceMs);
    }

    return { result, abort: () => stop('aborted') };
}
