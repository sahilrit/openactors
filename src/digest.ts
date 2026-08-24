#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { loadConfig, PROJECT_ROOT, type SavedSearch } from './digest/config.js';
import { diff, loadState, prune, saveState } from './digest/state.js';
import { assessHealth, recordYield, type HealthVerdict, type SearchHealth } from './digest/health.js';
import { applyMarks, markKey, type MarkStore } from './digest/marks.js';
import { inferDisplay, renderHtml, renderMarkdown, type SearchResult } from './digest/render.js';
import { discoverActors } from './registry.js';
import { Runtime } from './runtime.js';
import { configureStorage, openDataset, openKeyValueStore } from './storage.js';
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

    const record = await runtime.call(manifest, search.input ?? {}, {
        timeoutSecs: search.timeoutSecs ?? 300,
        origin: 'SCHEDULER',
    });
    if (record.status === 'FAILED') {
        return { ...base, error: record.errorMessage ?? 'run failed' };
    }

    const items = await readAll(record.defaultDatasetId);
    return { ...base, fresh: items, display: search.display ?? inferDisplay(items) };
}

/**
 * Reads each posting and drops the ones whose text contradicts the remote tag.
 *
 * Failures here are deliberately non-fatal: if verification cannot run, the
 * unverified roles are still reported. Losing a day's results to a broken
 * check would be a worse outcome than showing a few roles that turn out to be
 * hybrid.
 */
async function verifyRemote(
    search: SavedSearch,
    items: Record<string, unknown>[],
    runtime: Runtime,
    installed: Awaited<ReturnType<typeof discoverActors>>,
): Promise<Record<string, unknown>[]> {
    const manifest = installed.find((a) => a.name === 'jobs/verify-remote');
    if (!manifest) return items;

    const keep = new Set(search.keepVerdicts ?? ['remote', 'unclear']);
    const urls = items.map((i) => String(i.url ?? '')).filter((u) => /^https?:/.test(u));
    if (urls.length === 0) return items;

    try {
        const run = await runtime.call(manifest, { urls, maxConcurrent: 5 }, {
            timeoutSecs: Math.min(900, 30 + urls.length * 3),
            origin: 'SCHEDULER',
        });
        if (run.status !== 'SUCCEEDED') return items;

        const dataset = await openDataset(run.defaultDatasetId);
        const { items: verdicts } = await dataset.getData({ limit: 5000 });

        const byUrl = new Map(verdicts.map((v) => [String(v.url), v]));
        return items.filter((i) => {
            const verdict = byUrl.get(String(i.url ?? ''));
            // Unchecked stays in: absence of a verdict is not evidence against.
            if (!verdict) return true;
            (i as Record<string, unknown>).workplace = verdict.verdict;
            (i as Record<string, unknown>).workplaceEvidence = verdict.evidence;
            return keep.has(String(verdict.verdict));
        });
    } catch (err) {
        console.error(`[digest]   verification unavailable: ${(err as Error).message}`);
        return items;
    }
}

async function main(): Promise<void> {
    configureStorage();

    const { config, path } = await loadConfig(process.argv[2]);
    const now = new Date();
    const runtime = new Runtime();
    await runtime.load();

    const marksStore = await openKeyValueStore('job-marks');
    const marks = (await marksStore.getValue<MarkStore>('marks')) ?? {};

    const healthStore = await openKeyValueStore('digest-health');
    const health = (await healthStore.getValue<Record<string, SearchHealth>>('health')) ?? {};

    // Roles seen earlier in *this* run. Several searches legitimately match the
    // same posting, and showing it once per section is noise rather than signal.
    const seenThisRun = new Set<string>();
    let duplicatesSuppressed = 0;
    let markedSuppressed = 0;

    const installed = await discoverActors();
    runtime.resolveActor = (name) => installed.find((a) => a.name === resolveActorName(name));
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

        // Health is judged on everything scraped, not on what survived the
        // filters: "new" legitimately falls to zero, total does not.
        const scrapedTotal = result.fresh.length;
        const priorHealth = health[search.name] ?? { yields: [], lastTotal: 0 };
        const verdict = assessHealth(priorHealth, scrapedTotal);
        health[search.name] = recordYield(priorHealth, scrapedTotal);

        if (verdict.status !== 'ok') {
            console.error(`[digest]   ${verdict.status.toUpperCase()}: ${verdict.reason}`);
        }

        // Verification runs before anything else is decided, so a role that
        // contradicts its own remote tag never reaches the digest at all.
        if (search.verifyRemote && result.fresh.length > 0) {
            const before = result.fresh.length;
            result = { ...result, fresh: await verifyRemote(search, result.fresh, runtime, installed) };
            console.error(`[digest]   verified: ${result.fresh.length} of ${before} postings support the remote claim`);
        }

        const afterMarks = applyMarks(result.fresh, marks);
        markedSuppressed += afterMarks.removed;

        const deduped = afterMarks.items.filter((item) => {
            const key = markKey(item);
            if (key === null) return true;
            if (seenThisRun.has(key)) {
                duplicatesSuppressed++;
                return false;
            }
            seenThisRun.add(key);
            return true;
        });
        result = { ...result, fresh: deduped, health: verdict };

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
    await healthStore.setValue('health', health);

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
    const unhealthy = results.filter((r) => r.health && r.health.status !== 'ok');

    // stdout carries the summary so a scheduler's log is useful on its own.
    console.log(`${total} new result(s)${failed > 0 ? `, ${failed} search(es) failed` : ''} — ${written[0]}`);
    if (duplicatesSuppressed > 0 || markedSuppressed > 0) {
        console.log(`  (${duplicatesSuppressed} duplicate, ${markedSuppressed} already-handled row(s) suppressed)`);
    }
    for (const r of unhealthy) {
        console.log(`  ${r.health!.status.toUpperCase()}  ${r.name}: ${r.health!.reason}`);
    }
    for (const result of results.filter((r) => r.fresh.length > 0)) {
        console.log(`  ${result.fresh.length.toString().padStart(4)}  ${result.name}`);
    }

    // Both a failed search and a silently-broken one are worth a non-zero exit,
    // so a scheduler surfaces them rather than logging success either way.
    process.exit(failed > 0 || unhealthy.some((r) => r.health!.status === 'broken') ? 1 : 0);
}

main().catch((err) => {
    console.error('[digest] fatal:', err instanceof Error ? err.message : err);
    process.exit(2);
});
