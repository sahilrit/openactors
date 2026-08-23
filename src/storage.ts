import { resolve } from 'node:path';
import { Configuration, Dataset, KeyValueStore } from '@crawlee/core';
import { PROJECT_ROOT } from './paths.js';

/**
 * Crawlee is Apify's own storage engine, MIT-licensed. We reuse Dataset and
 * KeyValueStore wholesale rather than reimplementing them — that is most of the
 * "platform" layer of Apify, for free.
 *
 * Two settings matter:
 *  - Storage is pinned to the project root. An MCP server is launched by a
 *    client with an arbitrary working directory, so relying on Crawlee's
 *    cwd-relative default would scatter datasets wherever the client happened
 *    to start us.
 *  - Purge-on-start is off. Datasets outlive the run that created them, because
 *    `get-dataset-items` is a separate call made after `call-actor` returns.
 */
export function configureStorage(): void {
    process.env.CRAWLEE_STORAGE_DIR ??= resolve(PROJECT_ROOT, 'storage');

    const config = Configuration.getGlobalConfig();
    config.set('persistStorage', true);
    config.set('purgeOnStart', false);
}

export async function openDataset(name: string): Promise<Dataset> {
    return Dataset.open(name);
}

export async function openKeyValueStore(name: string): Promise<KeyValueStore> {
    return KeyValueStore.open(name);
}

export { Dataset, KeyValueStore };

/**
 * Lists storages by reading the storage directory.
 *
 * Crawlee has no listing API — it opens storages by name and nothing more — so
 * the directory is the only source of truth for what exists. Reading it also
 * picks up storages written by a previous process, which an in-memory registry
 * would miss.
 */
export interface StorageSummary {
    id: string;
    modifiedAt: string;
}

export async function listStorages(
    kind: 'datasets' | 'key_value_stores' | 'request_queues',
): Promise<StorageSummary[]> {
    const { readdir, stat } = await import('node:fs/promises');
    const root = process.env.CRAWLEE_STORAGE_DIR ?? resolve(PROJECT_ROOT, 'storage');
    const base = resolve(root, kind);

    const entries = await readdir(base, { withFileTypes: true }).catch(() => []);
    const summaries = await Promise.all(
        entries
            .filter((e) => e.isDirectory())
            .map(async (e) => {
                const info = await stat(resolve(base, e.name)).catch(() => null);
                return { id: e.name, modifiedAt: new Date(info?.mtimeMs ?? 0).toISOString() };
            }),
    );

    // Newest first. Sorting by name looks right while ids share a prefix and
    // silently stops being newest-first the moment they do not — which is how
    // a list of recent runs ends up showing only whichever prefix sorts last.
    return summaries.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
}
