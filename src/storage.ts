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
export async function listStorages(kind: 'datasets' | 'key_value_stores' | 'request_queues'): Promise<string[]> {
    const { readdir } = await import('node:fs/promises');
    const root = process.env.CRAWLEE_STORAGE_DIR ?? resolve(PROJECT_ROOT, 'storage');

    const entries = await readdir(resolve(root, kind), { withFileTypes: true }).catch(() => []);
    return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
}
