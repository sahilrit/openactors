import { describe, expect, it } from 'vitest';
import { diff, prune, type SeenMap } from '../src/digest/state.js';
import { inferDisplay, renderMarkdown, type SearchResult } from '../src/digest/render.js';

const NOW = new Date('2026-08-23T09:00:00.000Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

describe('diff', () => {
    const items = [{ url: 'https://x.test/a' }, { url: 'https://x.test/b' }, { url: 'https://x.test/c' }];

    it('reports everything on a first run', () => {
        const { fresh, repeatCount } = diff(items, {}, 'url', NOW);
        expect(fresh).toHaveLength(3);
        expect(repeatCount).toBe(0);
    });

    it('reports only what has not been seen', () => {
        const seen: SeenMap = { 'https://x.test/a': daysAgo(1), 'https://x.test/b': daysAgo(1) };
        const { fresh, repeatCount } = diff(items, seen, 'url', NOW);
        expect(fresh.map((f) => f.url)).toEqual(['https://x.test/c']);
        expect(repeatCount).toBe(2);
    });

    it('reports nothing when the run repeats unchanged', () => {
        const first = diff(items, {}, 'url', NOW);
        const second = diff(items, first.updatedSeen, 'url', NOW);
        expect(second.fresh).toHaveLength(0);
        expect(second.repeatCount).toBe(3);
    });

    it('stamps newly seen keys so they can later be pruned', () => {
        const { updatedSeen } = diff(items, {}, 'url', NOW);
        expect(Object.keys(updatedSeen)).toHaveLength(3);
        for (const stamp of Object.values(updatedSeen)) expect(stamp).toBe(NOW.toISOString());
    });

    it('preserves the original first-seen date for a repeat', () => {
        const seen: SeenMap = { 'https://x.test/a': daysAgo(10) };
        const { updatedSeen } = diff(items, seen, 'url', NOW);
        expect(updatedSeen['https://x.test/a']).toBe(daysAgo(10));
    });

    it('treats an item with no usable key as new', () => {
        // Showing a role twice is a smaller failure than never showing it.
        const { fresh } = diff([{ url: '' }, { url: null } as any, {} as any], {}, 'url', NOW);
        expect(fresh).toHaveLength(3);
    });

    it('trims whitespace so a padded key is not seen as different', () => {
        const { repeatCount } = diff([{ url: '  https://x.test/a  ' }], { 'https://x.test/a': daysAgo(1) }, 'url', NOW);
        expect(repeatCount).toBe(1);
    });

    it('honours a non-default key field', () => {
        const { repeatCount } = diff([{ id: '42', url: 'https://x.test/z' }], { '42': daysAgo(1) }, 'id', NOW);
        expect(repeatCount).toBe(1);
    });
});

describe('state shape', () => {
    it('reads the older bare-SeenMap shape without discarding history', async () => {
        // Discarding it would report every already-known item as new again.
        const { loadState, saveState } = await import('../src/digest/state.js');
        const { configureStorage, openKeyValueStore } = await import('../src/storage.js');
        configureStorage();
        const store = await openKeyValueStore('digest-state');
        await store.setValue('seen', { Legacy: { 'https://x.test/a': daysAgo(2) } });

        const state = await loadState();
        expect(state.Legacy.seen['https://x.test/a']).toBe(daysAgo(2));
        expect(state.Legacy.lastRunAt).toBeUndefined();

        await store.setValue('seen', null);
    });
});

describe('prune', () => {
    it('forgets keys older than the window and keeps the rest', () => {
        const seen: SeenMap = { old: daysAgo(120), recent: daysAgo(10), today: daysAgo(0) };
        expect(Object.keys(prune(seen, 90, NOW)).sort()).toEqual(['recent', 'today']);
    });

    it('keeps an unparseable timestamp rather than resurfacing the item', () => {
        expect(prune({ weird: 'not-a-date' }, 90, NOW)).toEqual({ weird: 'not-a-date' });
    });

    it('leaves an empty state empty', () => {
        expect(prune({}, 90, NOW)).toEqual({});
    });
});

describe('renderMarkdown', () => {
    const base = { actor: 'jobs/ats-boards', repeatCount: 0, firstRun: false, display: [] };

    it('says so plainly when there is nothing new', () => {
        const md = renderMarkdown([{ ...base, name: 'Jobs', fresh: [], repeatCount: 12 }], NOW);
        expect(md).toContain('Nothing new since the last run.');
        expect(md).toContain('12 already-seen');
    });

    it('renders a table and links the first column', () => {
        const md = renderMarkdown(
            [{ ...base, name: 'Jobs', fresh: [{ title: 'Growth Lead', company: 'Acme', url: 'https://x.test/1' }], display: ['title', 'company'] }],
            NOW,
        );
        expect(md).toContain('| title | company |');
        expect(md).toContain('[Growth Lead](https://x.test/1)');
    });

    it('surfaces a failed search instead of hiding it', () => {
        const md = renderMarkdown([{ ...base, name: 'Broken', fresh: [], error: 'HTTP 500' }], NOW);
        expect(md).toContain('Failed: HTTP 500');
    });

    it('flags a first run, so a large digest is not mistaken for a surge', () => {
        const md = renderMarkdown([{ ...base, name: 'Jobs', fresh: [{ title: 'A', url: 'https://x.test/1' }], firstRun: true }], NOW);
        expect(md).toMatch(/First run/i);
    });

    it('escapes a pipe so one value cannot break the table', () => {
        const md = renderMarkdown([{ ...base, name: 'Jobs', fresh: [{ title: 'A | B' }], display: ['title'] }], NOW);
        expect(md).toContain('A \\| B');
    });

    it('shortens ISO timestamps to dates', () => {
        const md = renderMarkdown(
            [{ ...base, name: 'Jobs', fresh: [{ title: 'A', postedAt: '2026-08-11T00:00:00.000Z' }], display: ['title', 'postedAt'] }],
            NOW,
        );
        expect(md).toContain('2026-08-11');
        expect(md).not.toContain('T00:00:00');
    });
});

describe('inferDisplay', () => {
    it('prefers meaningful job fields over incidental ones', () => {
        const fields = inferDisplay([{ scrapedAt: 'x', title: 'A', company: 'B', id: '1', location: 'C' }]);
        expect(fields.slice(0, 3)).toEqual(['title', 'company', 'location']);
    });

    it('falls back to whatever keys exist for an unfamiliar shape', () => {
        expect(inferDisplay([{ alpha: 1, beta: 2 }])).toEqual(['alpha', 'beta']);
    });

    it('returns nothing for no items', () => {
        expect(inferDisplay([])).toEqual([]);
    });
});
