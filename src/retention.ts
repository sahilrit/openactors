import { readdir, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { PROJECT_ROOT } from './paths.js';

/**
 * Deletes storages that nothing is going to read again.
 *
 * Every run creates a dataset, so a server left running accumulates one per
 * run forever — a few hundred within a day of ordinary use. Apify expires
 * unnamed storages after seven days for the same reason.
 *
 * Age is taken from the directory's own mtime rather than parsed out of the
 * run id: a storage written by hand, or by an older naming scheme, still ages
 * out correctly.
 */

export interface CleanupOptions {
    keepDays?: number;
    /** Storage names never removed, whatever their age. */
    protect?: string[];
    /** Report what would be removed without removing it. */
    dryRun?: boolean;
    /**
     * Only consider storages whose name matches. Age alone cannot separate
     * throwaway storages from real ones when both were created the same day —
     * which is exactly the situation after a testing session.
     *
     * Supplying this also waives the age check, since a name pattern is the
     * more specific instruction of the two.
     */
    match?: string;
}

export interface CleanupResult {
    removed: string[];
    kept: number;
    freedBytes: number;
}

const DEFAULT_KEEP_DAYS = 7;

/** Named stores hold configuration, not run output; losing them breaks the server. */
const ALWAYS_PROTECT = ['default', 'runs', 'tasks', 'schedules', 'digest-state', 'linkedin-budget'];

async function directorySize(path: string): Promise<number> {
    const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
    let total = 0;
    for (const entry of entries) {
        const child = join(path, entry.name);
        if (entry.isDirectory()) total += await directorySize(child);
        else total += (await stat(child).catch(() => ({ size: 0 }))).size;
    }
    return total;
}

export async function cleanupStorages(options: CleanupOptions = {}): Promise<CleanupResult> {
    const keepDays = options.keepDays ?? DEFAULT_KEEP_DAYS;
    const protect = new Set([...ALWAYS_PROTECT, ...(options.protect ?? [])]);
    const cutoff = Date.now() - keepDays * 86_400_000;

    let pattern: RegExp | null = null;
    if (options.match) {
        try {
            pattern = new RegExp(options.match);
        } catch (err) {
            // Refused rather than ignored: silently treating a bad pattern as
            // "match everything" would delete the whole storage directory.
            throw new Error(`invalid match pattern "${options.match}": ${(err as Error).message}`);
        }
    }

    const root = process.env.CRAWLEE_STORAGE_DIR ?? resolve(PROJECT_ROOT, 'storage');
    const result: CleanupResult = { removed: [], kept: 0, freedBytes: 0 };

    for (const kind of ['datasets', 'key_value_stores', 'request_queues'] as const) {
        const base = join(root, kind);
        const entries = await readdir(base, { withFileTypes: true }).catch(() => []);

        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            if (protect.has(entry.name)) {
                result.kept++;
                continue;
            }

            if (pattern && !pattern.test(entry.name)) {
                result.kept++;
                continue;
            }

            const path = join(base, entry.name);
            const info = await stat(path).catch(() => null);
            if (!info) {
                result.kept++;
                continue;
            }
            // A name pattern is the more specific instruction; when one is
            // given, age is not also required.
            if (!pattern && info.mtimeMs >= cutoff) {
                result.kept++;
                continue;
            }

            const size = await directorySize(path);
            if (!options.dryRun) await rm(path, { recursive: true, force: true });
            result.removed.push(`${kind}/${entry.name}`);
            result.freedBytes += size;
        }
    }

    return result;
}
