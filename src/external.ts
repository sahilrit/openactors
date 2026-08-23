import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ActorRuntime } from './types.js';

/**
 * Runs an Actor written in any language.
 *
 * The contract is a line protocol on stdout, one JSON object per line:
 *
 *   {"type":"item","data":{...}}   a result row
 *   {"type":"log","message":"..."} a log line
 *
 * Input arrives as JSON on stdin. That is the whole interface — no SDK, no
 * bindings, no library to install. Anything that can read stdin and print
 * lines is an Actor, which is the point: the server never needs to know the
 * language exists.
 *
 * Anything on stdout that is not valid JSON is treated as a log line rather
 * than an error, because a print() left in during debugging should not fail a
 * run that otherwise worked.
 */

export interface ExternalEvents {
    onItem(item: Record<string, unknown>): void;
    onLog(message: string): void;
}

export interface ExternalProcess {
    child: ChildProcess;
    /** Resolves with the exit code once the process ends and stdout is drained. */
    done: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

const PYTHON_CANDIDATES = ['python3', 'python'];

/** Resolves a runtime declaration to an executable and its arguments. */
export function resolveCommand(runtime: ActorRuntime, dir: string): { command: string; args: string[] } {
    if (typeof runtime === 'object') {
        return { command: runtime.command, args: runtime.args ?? [] };
    }

    if (runtime === 'python') {
        const entry = ['main.py', '__main__.py'].map((f) => join(dir, f)).find((f) => existsSync(f));
        if (!entry) throw new Error(`a python Actor needs main.py in ${dir}`);
        // Resolved at run time rather than assumed: "python" is Python 2 on
        // some systems and absent entirely on others.
        const command = PYTHON_CANDIDATES.find((c) => c) ?? 'python3';
        return { command, args: ['-u', entry] };
    }

    throw new Error(`unsupported runtime: ${JSON.stringify(runtime)}`);
}

export function startExternal(
    runtime: ActorRuntime,
    dir: string,
    input: unknown,
    env: Record<string, string>,
    events: ExternalEvents,
): ExternalProcess {
    const { command, args } = resolveCommand(runtime, dir);

    const child = spawn(command, args, {
        cwd: dir,
        // -u / unbuffered above matters: a buffered child would deliver all its
        // output at exit, so a long run would appear to produce nothing until
        // it finished, and a killed one would lose everything.
        env: { ...process.env, ...env },
        stdio: ['pipe', 'pipe', 'pipe'],
    });

    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
        buffer += chunk;
        const lines = buffer.split('\n');
        // The last element is whatever came after the final newline: an
        // incomplete line that must wait for the rest of its JSON.
        buffer = lines.pop() ?? '';
        for (const line of lines) handleLine(line, events);
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
        for (const line of chunk.split('\n')) {
            if (line.trim() !== '') events.onLog(`[stderr] ${line}`);
        }
    });

    const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        let exited: { code: number | null; signal: NodeJS.Signals | null } | null = null;
        let stdoutEnded = false;

        const settle = () => {
            if (!exited || !stdoutEnded) return;
            // Flush a trailing line with no newline before reporting.
            if (buffer.trim() !== '') handleLine(buffer, events);
            resolve(exited);
        };

        child.on('exit', (code, signal) => {
            exited = { code, signal };
            settle();
        });
        // Waiting for stdout to end as well as exit: the process can exit
        // before its final buffered output has been read, and reporting then
        // would silently drop the last results.
        child.stdout.on('end', () => {
            stdoutEnded = true;
            settle();
        });
        child.on('error', (err) => {
            events.onLog(`failed to start "${command}": ${err.message}`);
            exited = { code: 127, signal: null };
            stdoutEnded = true;
            settle();
        });
    });

    child.stdin.write(JSON.stringify(input ?? {}));
    child.stdin.end();

    return { child, done };
}

function handleLine(line: string, events: ExternalEvents): void {
    const trimmed = line.trim();
    if (trimmed === '') return;

    if (!trimmed.startsWith('{')) {
        events.onLog(trimmed);
        return;
    }

    let parsed: { type?: string; data?: unknown; message?: unknown };
    try {
        parsed = JSON.parse(trimmed);
    } catch {
        events.onLog(trimmed);
        return;
    }

    if (parsed.type === 'item' && parsed.data && typeof parsed.data === 'object') {
        events.onItem(parsed.data as Record<string, unknown>);
    } else if (parsed.type === 'log') {
        events.onLog(String(parsed.message ?? ''));
    } else {
        // Valid JSON with no recognised type is most likely a result the author
        // forgot to wrap; keeping it beats discarding a scraped row.
        events.onItem(parsed as Record<string, unknown>);
    }
}
