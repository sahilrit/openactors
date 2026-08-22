import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { ActorManifest, ActorRunFn } from './types.js';

const HERE = dirname(fileURLToPath(import.meta.url));
/** `src/` and `dist/` both sit one level under the project root. */
export const ACTORS_DIR = resolve(HERE, '..', 'actors');

/**
 * Discovers Actors on disk. An Actor is any `actors/<namespace>/<name>/`
 * directory containing an `actor.json`; its id is `<namespace>/<name>`.
 *
 * Scanning is filesystem-only and side-effect free — no Actor code is imported
 * until it is actually called. A syntax error in one Actor therefore cannot
 * stop the server from starting.
 */
export async function discoverActors(actorsDir = ACTORS_DIR): Promise<ActorManifest[]> {
    const found: ActorManifest[] = [];

    const namespaces = await readdir(actorsDir, { withFileTypes: true }).catch(() => []);
    for (const ns of namespaces) {
        if (!ns.isDirectory()) continue;

        const entries = await readdir(join(actorsDir, ns.name), { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
            if (!entry.isDirectory()) continue;

            const dir = join(actorsDir, ns.name, entry.name);
            const raw = await readFile(join(dir, 'actor.json'), 'utf8').catch(() => null);
            if (raw === null) continue;

            let parsed: Partial<ActorManifest>;
            try {
                parsed = JSON.parse(raw);
            } catch (err) {
                // A malformed manifest is a bug in one Actor, not a fatal
                // condition for the registry. Skip it loudly and carry on.
                console.error(`[registry] skipping ${ns.name}/${entry.name}: invalid actor.json (${(err as Error).message})`);
                continue;
            }

            found.push({
                name: `${ns.name}/${entry.name}`,
                title: parsed.title ?? entry.name,
                description: parsed.description ?? '',
                tags: parsed.tags ?? [],
                input: parsed.input ?? { type: 'object', properties: {} },
                gatedReason: parsed.gatedReason,
                dir,
            });
        }
    }

    return found.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Ranks Actors against a free-text query. Matches on id, title, description and
 * tags, weighted so that an id match outranks a passing mention in prose.
 * An empty query returns everything, which is what `search-actors` wants when
 * an agent is browsing rather than searching.
 */
export function searchActors(actors: ActorManifest[], query: string, limit = 20): ActorManifest[] {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return actors.slice(0, limit);

    const scored = actors.map((actor) => {
        const name = actor.name.toLowerCase();
        const title = actor.title.toLowerCase();
        const description = actor.description.toLowerCase();
        const tags = actor.tags.map((t) => t.toLowerCase());

        let score = 0;
        for (const term of terms) {
            if (name.includes(term)) score += 10;
            if (tags.some((t) => t === term)) score += 6;
            if (title.toLowerCase().includes(term)) score += 4;
            if (tags.some((t) => t.includes(term))) score += 2;
            if (description.includes(term)) score += 1;
        }
        return { actor, score };
    });

    return scored
        .filter((s) => s.score > 0)
        .sort((a, b) => b.score - a.score || a.actor.name.localeCompare(b.actor.name))
        .slice(0, limit)
        .map((s) => s.actor);
}

/**
 * Imports an Actor's entry point and returns its `run` export.
 * Deferred until call time so that discovery stays cheap and failure-isolated.
 *
 * Resolves `main.ts` or `main.js` depending on how the server was started:
 * `tsx` runs straight from source, while a compiled `dist/` has only JS.
 */
export async function loadActorRunFn(manifest: ActorManifest): Promise<ActorRunFn> {
    const candidates = ['main.ts', 'main.js'].map((f) => join(manifest.dir, f));
    const entry = candidates.find((f) => existsSync(f));
    if (!entry) {
        throw new Error(`Actor "${manifest.name}" has no main.ts or main.js in ${manifest.dir}`);
    }

    const mod = await import(pathToFileURL(entry).href);
    const run = mod.run ?? mod.default;
    if (typeof run !== 'function') {
        throw new Error(`Actor "${manifest.name}" does not export a run() function from ${entry}`);
    }
    return run as ActorRunFn;
}
