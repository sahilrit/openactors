import { describe, expect, it } from 'vitest';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCommand, startExternal } from '../src/external.js';

const ACTORS = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'actors');

function collect(actor: string, input: unknown) {
    const items: Record<string, unknown>[] = [];
    const logs: string[] = [];
    const { done } = startExternal('python', join(ACTORS, actor), input, {}, {
        onItem: (i) => items.push(i),
        onLog: (m) => logs.push(m),
    });
    return { done, items, logs };
}

describe('the line protocol', () => {
    it('collects items and logs from a Python Actor', async () => {
        const { done, items, logs } = collect('py-echo', { n: 3, echo: 'hi' });
        const { code } = await done;
        expect(code).toBe(0);
        expect(items.filter((i) => typeof i.i === 'number')).toHaveLength(3);
        expect(items[1]).toMatchObject({ i: 0, echo: 'hi' });
        expect(logs).toContain('starting');
    }, 30_000);

    it('treats a stray print as a log rather than failing the run', async () => {
        // A print() left in during debugging should not lose a whole crawl.
        const { done, logs } = collect('py-echo', { n: 1 });
        await done;
        expect(logs).toContain('a bare print left in during debugging');
    }, 30_000);

    it('keeps a JSON object the author forgot to wrap', async () => {
        const { done, items } = collect('py-echo', { n: 1 });
        await done;
        expect(items.some((i) => i.bare === 'object with no type')).toBe(true);
    }, 30_000);

    it('does not lose a final line written without a trailing newline', async () => {
        // The stream splits on newlines; the last fragment has none, and
        // dropping it would silently discard the run's last result.
        const { done, items } = collect('py-echo', { n: 1 });
        await done;
        expect(items.some((i) => i.trailing === 'no newline')).toBe(true);
    }, 30_000);

    it('reports a non-zero exit and keeps what was produced first', async () => {
        const { done, items, logs } = collect('py-fail', {});
        const { code } = await done;
        expect(code).toBe(4);
        expect(items).toEqual([{ before: 'the failure' }]);
        expect(logs.join(' ')).toContain('something went wrong');
    }, 30_000);

    it('reports a missing interpreter as a failure, not a crash', async () => {
        const { done, logs } = startExternal(
            { command: 'definitely-not-a-real-command-xyz' },
            ACTORS, {}, {},
            { onItem: () => {}, onLog: () => {} },
        ) as any;
        const { code } = await done;
        expect(code).toBe(127);
    }, 30_000);
});

describe('resolveCommand', () => {
    it('finds main.py for a python Actor', () => {
        const resolved = resolveCommand('python', join(ACTORS, 'py-echo'));
        expect(resolved.command).toMatch(/python3?/);
        // -u keeps stdout unbuffered, so a long run streams instead of
        // delivering everything at exit.
        expect(resolved.args).toContain('-u');
    });

    it('says so plainly when a python Actor has no entry point', () => {
        expect(() => resolveCommand('python', join(ACTORS, 'ok'))).toThrow(/needs main\.py/);
    });

    it('passes an explicit command through unchanged', () => {
        expect(resolveCommand({ command: 'bash', args: ['run.sh'] }, ACTORS)).toEqual({ command: 'bash', args: ['run.sh'] });
    });
});
