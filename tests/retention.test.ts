import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, utimes, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanupStorages } from '../src/retention.js';

const DAY = 86_400_000;

// These tests repoint the storage directory. Vitest isolates files in separate
// processes, but restoring it keeps that an implementation detail rather than
// something the suite silently depends on.
let original: string | undefined;
beforeAll(() => {
    original = process.env.CRAWLEE_STORAGE_DIR;
});
afterAll(() => {
    if (original === undefined) delete process.env.CRAWLEE_STORAGE_DIR;
    else process.env.CRAWLEE_STORAGE_DIR = original;
});

async function storageDir(entries: Array<{ kind: string; name: string; ageDays: number }>): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'openactors-retention-'));
    for (const entry of entries) {
        const dir = join(root, entry.kind, entry.name);
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, '000001.json'), '{"a":1}');
        const when = new Date(Date.now() - entry.ageDays * DAY);
        await utimes(dir, when, when);
    }
    return root;
}

describe('cleanupStorages', () => {
    it('removes storages past the window and keeps recent ones', async () => {
        process.env.CRAWLEE_STORAGE_DIR = await storageDir([
            { kind: 'datasets', name: 'run-old', ageDays: 30 },
            { kind: 'datasets', name: 'run-new', ageDays: 1 },
        ]);

        const result = await cleanupStorages({ keepDays: 7 });
        expect(result.removed).toEqual(['datasets/run-old']);
        expect(await readdir(join(process.env.CRAWLEE_STORAGE_DIR!, 'datasets'))).toEqual(['run-new']);
    });

    it('never removes the stores holding configuration', async () => {
        // Losing these breaks the server: run history, tasks, schedules and
        // the digest's seen-state all live in named stores.
        process.env.CRAWLEE_STORAGE_DIR = await storageDir([
            { kind: 'key_value_stores', name: 'runs', ageDays: 400 },
            { kind: 'key_value_stores', name: 'schedules', ageDays: 400 },
            { kind: 'key_value_stores', name: 'digest-state', ageDays: 400 },
            { kind: 'key_value_stores', name: 'tasks', ageDays: 400 },
            { kind: 'key_value_stores', name: 'junk', ageDays: 400 },
        ]);

        const result = await cleanupStorages({ keepDays: 7 });
        expect(result.removed).toEqual(['key_value_stores/junk']);
    });

    it('reports without deleting when asked to', async () => {
        process.env.CRAWLEE_STORAGE_DIR = await storageDir([{ kind: 'datasets', name: 'run-old', ageDays: 30 }]);

        const result = await cleanupStorages({ keepDays: 7, dryRun: true });
        expect(result.removed).toEqual(['datasets/run-old']);
        expect(result.freedBytes).toBeGreaterThan(0);
        // Still there: a dry run that deleted anything would be a trap.
        expect(await readdir(join(process.env.CRAWLEE_STORAGE_DIR!, 'datasets'))).toEqual(['run-old']);
    });

    it('honours extra protected names', async () => {
        process.env.CRAWLEE_STORAGE_DIR = await storageDir([{ kind: 'datasets', name: 'keep-me', ageDays: 99 }]);
        expect((await cleanupStorages({ keepDays: 1, protect: ['keep-me'] })).removed).toEqual([]);
    });

    it('does nothing on a storage directory that does not exist', async () => {
        process.env.CRAWLEE_STORAGE_DIR = join(tmpdir(), 'openactors-nonexistent-xyz');
        await expect(cleanupStorages()).resolves.toMatchObject({ removed: [] });
    });
});

describe('name matching', () => {
    it('removes only storages matching the pattern, ignoring age', async () => {
        // Age cannot separate throwaway from real when both are minutes old,
        // which is the state a testing session leaves behind.
        process.env.CRAWLEE_STORAGE_DIR = await storageDir([
            { kind: 'datasets', name: 'test-run-1', ageDays: 0 },
            { kind: 'datasets', name: 'test-run-2', ageDays: 0 },
            { kind: 'datasets', name: 'run-real', ageDays: 0 },
        ]);

        const result = await cleanupStorages({ match: '^test-run-' });
        expect(result.removed.sort()).toEqual(['datasets/test-run-1', 'datasets/test-run-2']);
        expect(await readdir(join(process.env.CRAWLEE_STORAGE_DIR!, 'datasets'))).toEqual(['run-real']);
    });

    it('still protects configuration stores when a pattern would match them', async () => {
        process.env.CRAWLEE_STORAGE_DIR = await storageDir([
            { kind: 'key_value_stores', name: 'runs', ageDays: 0 },
            { kind: 'key_value_stores', name: 'runs-scratch', ageDays: 0 },
        ]);

        const result = await cleanupStorages({ match: '^runs' });
        expect(result.removed).toEqual(['key_value_stores/runs-scratch']);
    });

    it('refuses an invalid pattern rather than matching everything', async () => {
        // Treating a broken pattern as "match all" would delete the lot.
        process.env.CRAWLEE_STORAGE_DIR = await storageDir([{ kind: 'datasets', name: 'a', ageDays: 0 }]);
        await expect(cleanupStorages({ match: '([unclosed' })).rejects.toThrow(/invalid match pattern/);
    });
});
