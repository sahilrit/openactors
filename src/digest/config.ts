import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { PROJECT_ROOT } from '../paths.js';

export { PROJECT_ROOT };

export interface SavedSearch {
    name: string;
    actor: string;
    input: Record<string, unknown>;
    /**
     * Field used to recognise an item seen before. Defaults to `url`, which is
     * stable across runs for every Actor here — ids are not, since the same
     * posting reached through two boards carries two different ids.
     */
    key?: string;
    /** Fields shown in the digest, in order. Falls back to a sensible guess. */
    display?: string[];
    timeoutSecs?: number;
}

export interface DigestConfig {
    searches: SavedSearch[];
    output: {
        dir: string;
        /** Days a key stays remembered. Bounds state growth on long-lived searches. */
        keepDays: number;
    };
}

const DEFAULTS: DigestConfig['output'] = { dir: 'digests', keepDays: 90 };

export async function loadConfig(path?: string): Promise<{ config: DigestConfig; path: string }> {
    const file = resolve(path ?? process.env.OPENACTORS_SEARCHES ?? resolve(PROJECT_ROOT, 'searches.json'));

    let raw: string;
    try {
        raw = await readFile(file, 'utf8');
    } catch {
        throw new Error(
            `No saved searches at ${file}. Copy searches.example.json to searches.json and edit it, ` +
                'or point OPENACTORS_SEARCHES at another file.',
        );
    }

    let parsed: Partial<DigestConfig>;
    try {
        parsed = JSON.parse(raw);
    } catch (err) {
        throw new Error(`${file} is not valid JSON: ${(err as Error).message}`);
    }

    const searches = parsed.searches;
    if (!Array.isArray(searches) || searches.length === 0) {
        throw new Error(`${file} must contain a non-empty "searches" array.`);
    }

    // Validate up front rather than failing partway through a run that has
    // already spent minutes on the network.
    searches.forEach((search, i) => {
        if (!search?.name) throw new Error(`searches[${i}] is missing "name"`);
        if (!search?.actor) throw new Error(`searches[${i}] ("${search.name}") is missing "actor"`);
        if (search.input && typeof search.input !== 'object') {
            throw new Error(`searches[${i}] ("${search.name}") has a non-object "input"`);
        }
    });

    const names = searches.map((s) => s.name);
    const duplicate = names.find((n, i) => names.indexOf(n) !== i);
    if (duplicate) {
        // Names key the seen-state, so duplicates would silently share history.
        throw new Error(`Two searches are both named "${duplicate}". Names must be unique.`);
    }

    return {
        config: { searches, output: { ...DEFAULTS, ...(parsed.output ?? {}) } },
        path: file,
    };
}
