import { dirname, join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Configuration, Dataset, KeyValueStore } from '@crawlee/core';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Walks up to the directory holding package.json. Running from `src/` and from
 * a compiled `dist/src/` are different depths, and hardcoding one sends the
 * built server's storage to `dist/storage` while dev writes to `./storage` —
 * same server, two different sets of results.
 */
function findProjectRoot(from: string): string {
    let dir = from;
    for (let i = 0; i < 5; i++) {
        if (existsSync(join(dir, 'package.json'))) return dir;
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return resolve(from, '..');
}

const PROJECT_ROOT = findProjectRoot(HERE);

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
