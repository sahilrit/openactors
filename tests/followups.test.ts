import { describe, expect, it } from 'vitest';
import { followUpsDue, recordResponse, type MarkStore } from '../src/digest/marks.js';

const NOW = new Date('2026-09-01T09:00:00.000Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

const store = (entries: Record<string, Partial<MarkStore[string]>>): MarkStore =>
    Object.fromEntries(Object.entries(entries).map(([url, r]) => [url, { mark: 'applied', markedAt: daysAgo(30), ...r } as MarkStore[string]]));

describe('followUpsDue', () => {
    it('flags an application that has gone quiet past the window', () => {
        const due = followUpsDue(store({ 'https://x.test/a': { markedAt: daysAgo(10) } }), 7, NOW);
        expect(due.map((d) => d.url)).toEqual(['https://x.test/a']);
        expect(due[0].daysSince).toBe(10);
    });

    it('leaves a recent application alone', () => {
        expect(followUpsDue(store({ 'https://x.test/a': { markedAt: daysAgo(3) } }), 7, NOW)).toEqual([]);
    });

    it('never chases a role that was ignored rather than applied to', () => {
        expect(followUpsDue(store({ 'https://x.test/a': { mark: 'ignored', markedAt: daysAgo(30) } }), 7, NOW)).toEqual([]);
    });

    it('stops chasing once they have replied', () => {
        // Following up after a reply is worse than not following up: it reads
        // as not having read their message.
        for (const response of ['replied', 'interview', 'rejected', 'offer'] as const) {
            expect(followUpsDue(store({ 'https://x.test/a': { markedAt: daysAgo(30), response } }), 7, NOW), response).toEqual([]);
        }
    });

    it('does not chase twice within the same window', () => {
        const quiet = store({ 'https://x.test/a': { markedAt: daysAgo(30), followedUpAt: daysAgo(2) } });
        expect(followUpsDue(quiet, 7, NOW)).toEqual([]);
    });

    it('chases again once the window has passed since the last chase', () => {
        const quiet = store({ 'https://x.test/a': { markedAt: daysAgo(30), followedUpAt: daysAgo(9) } });
        expect(followUpsDue(quiet, 7, NOW)).toHaveLength(1);
    });

    it('puts the longest-waiting first, since those go coldest', () => {
        const due = followUpsDue(store({
            'https://x.test/new': { markedAt: daysAgo(8) },
            'https://x.test/old': { markedAt: daysAgo(40) },
            'https://x.test/mid': { markedAt: daysAgo(20) },
        }), 7, NOW);
        expect(due.map((d) => d.url)).toEqual(['https://x.test/old', 'https://x.test/mid', 'https://x.test/new']);
    });

    it('ignores an unparseable date rather than reporting a nonsense age', () => {
        expect(followUpsDue(store({ 'https://x.test/a': { markedAt: 'not-a-date' } }), 7, NOW)).toEqual([]);
    });
});

describe('recordResponse', () => {
    it('records what came back, with a timestamp', () => {
        const updated = recordResponse(store({ 'https://x.test/a': {} }), 'https://x.test/a', 'interview');
        expect(updated['https://x.test/a'].response).toBe('interview');
        expect(Number.isNaN(Date.parse(updated['https://x.test/a'].respondedAt!))).toBe(false);
    });

    it('normalises the url, so a link copied with tracking still matches', () => {
        const updated = recordResponse(store({ 'https://x.test/a': {} }), 'https://x.test/a?utm=x', 'replied');
        expect(updated['https://x.test/a'].response).toBe('replied');
        expect(Object.keys(updated)).toHaveLength(1);
    });

    it('leaves an unknown url untouched rather than inventing a record', () => {
        const before = store({ 'https://x.test/a': {} });
        expect(recordResponse(before, 'https://x.test/unknown', 'replied')).toEqual(before);
    });
});
