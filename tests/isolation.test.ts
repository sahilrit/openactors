import { describe, expect, it } from 'vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnActor } from '../src/spawn.js';
import { configureStorage } from '../src/storage.js';

configureStorage();

const ACTORS = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'actors');
let counter = 0;

function run(actor: string, over: Partial<Parameters<typeof spawnActor>[0]> = {}) {
    const logs: string[] = [];
    let onFirstItem: (() => void) | undefined;
    const firstItem = new Promise<void>((resolve) => {
        onFirstItem = resolve;
    });
    const handle = spawnActor({
        actorDir: join(ACTORS, actor),
        actorName: `test/${actor}`,
        runId: `test-run-${Date.now()}-${counter++}`,
        input: {},
        timeoutMs: 10_000,
        graceMs: 1_000,
        onLog: (m) => logs.push(m),
        onItems: () => onFirstItem?.(),
        ...over,
    });
    return { handle, logs, firstItem };
}

/**
 * The point of running Actors out-of-process is that none of these can take
 * the parent with them. Every case below would, in-process, kill the MCP
 * server and the scheduler depending on it.
 */
describe('subprocess isolation', () => {
    it('runs a well-behaved Actor and reports its items', async () => {
        const { handle, logs } = run('ok');
        const result = await handle.result;
        expect(result.outcome).toBe('done');
        expect(result.itemCount).toBe(3);
        expect(logs).toContain('starting');
    }, 30_000);

    it('survives an Actor that exits without reporting', async () => {
        const { handle } = run('crash-exit');
        const result = await handle.result;
        expect(result.outcome).toBe('crashed');
        expect(result.message).toMatch(/exited with code 3/);
        // What it managed to write before dying is still counted.
        expect(result.itemCount).toBe(1);
    }, 30_000);

    it('survives an Actor that throws from a stray callback', async () => {
        const { handle } = run('throw-async');
        const result = await handle.result;
        expect(result.outcome).toBe('error');
        expect(result.message).toMatch(/uncaught exception.*exploded/);
    }, 30_000);

    it('kills a synchronous infinite loop on timeout', async () => {
        // The case no AbortController can handle: the loop never yields, so
        // nothing in-process could ever regain control.
        const started = Date.now();
        const { handle } = run('infinite-sync', { timeoutMs: 1_500, graceMs: 500 });
        const result = await handle.result;
        expect(result.outcome).toBe('timeout');
        expect(Date.now() - started).toBeLessThan(15_000);
    }, 30_000);

    it('kills an Actor that exhausts its heap ceiling', async () => {
        const { handle } = run('hog-memory', { memoryMb: 64, timeoutMs: 25_000 });
        const result = await handle.result;
        // Either the heap limit aborts it (error) or the OS kills it (crashed);
        // both are contained, which is the property under test.
        expect(['crashed', 'error']).toContain(result.outcome);
    }, 40_000);

    it('lets a cooperative Actor stop during the grace period', async () => {
        const { handle, logs, firstItem } = run('slow-abortable', { graceMs: 3_000 });
        // Aborting on a wall-clock delay would race worker startup, which is
        // slower than the Actor's first push. Wait for real progress instead.
        await firstItem;
        handle.abort();
        const result = await handle.result;
        expect(result.outcome).toBe('aborted');
        expect(logs.join(' ')).toMatch(/stopped cleanly/);
        // It pushed some rows before being asked to stop.
        expect(result.itemCount).toBeGreaterThan(0);
    }, 30_000);

    it('reports a missing Actor as an error rather than throwing', async () => {
        const { handle } = run('does-not-exist');
        const result = await handle.result;
        expect(result.outcome).toBe('error');
        expect(result.message).toMatch(/no main\.ts or main\.js/);
    }, 30_000);

    it('leaves the parent process healthy after every one of those', () => {
        // Reached at all only because nothing above killed this process.
        expect(process.exitCode ?? 0).toBe(0);
    });
});
