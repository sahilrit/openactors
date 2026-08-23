#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { loadConfig, PROJECT_ROOT, type SavedSearch } from './digest/config.js';
import { diff, loadState, prune, saveState } from './digest/state.js';
import { inferDisplay, renderHtml, renderMarkdown, type SearchResult } from './digest/render.js';
import { discoverActors } from './registry.js';
import { Runtime } from './runtime.js';
import { configureStorage, openDataset } from './storage.js';
import { resolveActorName } from './aliases.js';

/** Read back in pages; a broad search can return more than one page holds. */
const PAGE = 500;

async function readAll(datasetId: string): Promise<Record<string, unknown>[]> {
    const dataset = await openDataset(datasetId);
    const items: Record<string, unknown>[] = [];
    for (let offset = 0; ; offset += PAGE) {
        const { items: page } = await dataset.getData({ offset, limit: PAGE });
        items.push(...page);
        if (page.length < PAGE) return items;
    }
}

async function runSearch(search: SavedSearch, runtime: Runtime, now: Date): Promise<SearchResult> {
    const base: SearchResult = {
        name: search.name,
        actor: search.actor,
        fresh: [],
        repeatCount: 0,
        firstRun: false,
        display: search.display ?? [],
    };

    const actors = await discoverActors();
    const manifest = actors.find((a) => a.name === resolveActorName(search.actor));
    if (!manifest) {
        return { ...base, error: `Actor "${search.actor}" not found. Available: ${actors.map((a) => a.name).join(', ')}` };
    }

    const record = await runtime.call(manifest, search.input ?? {}, (search.timeoutSecs ?? 300) * 1000);
    if (record.status === 'FAILED') {
        return { ...base, error: record.errorMessage ?? 'run failed' };
    }

    const items = await readAll(record.defaultDatasetId);
    return { ...base, fresh: items, display: search.display ?? inferDisplay(items) };
}

async function main(): Promise<void> {
    configureStorage();

    const { config, path } = await loadConfig(process.argv[2]);
    const now = new Date();
    const runtime = new Runtime();
    const state = await loadState();

    console.error(`[digest] ${config.searches.length} saved search(es) from ${path}`);

    const results: SearchResult[] = [];

    for (const search of config.searches) {
        console.error(`[digest] running "${search.name}" (${search.actor})…`);
        let result: SearchResult;
        try {
            result = await runSearch(search, runtime, now);
        } catch (err) {
            // One broken search must not lose the digest for all the others.
            result = {
                name: search.name,
                actor: search.actor,
                fresh: [],
                repeatCount: 0,
                firstRun: false,
                display: [],
                error: (err as Error).message,
            };
        }

        if (result.error) {
            console.error(`[digest]   failed: ${result.error}`);
            results.push(result);
            continue;
        }

        const previous = state[search.name];
        const firstRun = previous?.lastRunAt === undefined;
        const { fresh, repeatCount, updatedSeen } = diff(result.fresh, previous?.seen ?? {}, search.key ?? 'url', now);

        state[search.name] = {
            seen: prune(updatedSeen, config.output.keepDays, now),
            lastRunAt: now.toISOString(),
        };
        results.push({ ...result, fresh, repeatCount, firstRun });
        console.error(`[digest]   ${fresh.length} new, ${repeatCount} already seen${firstRun ? ' (first run)' : ''}`);
    }

    // State is saved only after every search has been processed, so an
    // interrupted run does not mark items seen that were never reported.
    await saveState(state);

    const outDir = resolve(PROJECT_ROOT, config.output.dir);
    await mkdir(outDir, { recursive: true });

    // Timestamped to the minute, not just the date. A digest reports what is
    // new *since the last run*, so on a sub-daily schedule two runs sharing a
    // date-only filename would overwrite each other and the earlier run's
    // results would be lost for good.
    const stamp = `${now.toISOString().slice(0, 10)}-${now.toISOString().slice(11, 16).replace(':', '')}`;
    const written: string[] = [];
    for (const [name, body] of [
        [`${stamp}.md`, renderMarkdown(results, now)],
        [`${stamp}.html`, renderHtml(results, now)],
        ['latest.md', renderMarkdown(results, now)],
        ['latest.html', renderHtml(results, now)],
    ] as const) {
        const file = join(outDir, name);
        await writeFile(file, body, 'utf8');
        written.push(file);
    }

    const total = results.reduce((sum, r) => sum + r.fresh.length, 0);
    const failed = results.filter((r) => r.error).length;

    // stdout carries the summary so a scheduler's log is useful on its own.
    console.log(`${total} new result(s)${failed > 0 ? `, ${failed} search(es) failed` : ''} — ${written[0]}`);
    for (const result of results.filter((r) => r.fresh.length > 0)) {
        console.log(`  ${result.fresh.length.toString().padStart(4)}  ${result.name}`);
    }

    // A failed search is worth a non-zero exit so a scheduler can surface it.
    process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
    console.error('[digest] fatal:', err instanceof Error ? err.message : err);
    process.exit(2);
});
