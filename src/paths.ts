import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Walks up to the directory holding package.json.
 *
 * Running from `src/` and from a compiled `dist/src/` are different depths, and
 * nesting differs per module (`src/storage.ts` vs `src/digest/config.ts`), so
 * any hardcoded `..` count is wrong somewhere. Getting this wrong is quiet:
 * storage lands in `dist/storage`, or a config file is looked for in `dist/`.
 */
export function findProjectRoot(fromFileUrl: string): string {
    let dir = dirname(fileURLToPath(fromFileUrl));
    for (let i = 0; i < 6; i++) {
        if (existsSync(join(dir, 'package.json'))) return dir;
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return resolve(dirname(fileURLToPath(fromFileUrl)), '..');
}

export const PROJECT_ROOT = findProjectRoot(import.meta.url);
