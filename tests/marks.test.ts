import { describe, expect, it } from 'vitest';
import { applyMarks, markKey, mergeMark, type MarkStore } from '../src/digest/marks.js';

const job = (url: string, extra: Record<string, unknown> = {}) => ({ url, title: 'Role', ...extra });

describe('markKey', () => {
    it('keys on the url, which is stable across runs', () => {
        expect(markKey(job('https://x.test/1'))).toBe('https://x.test/1');
    });

    it('strips tracking parameters so the same role is not marked twice', () => {
        expect(markKey(job('https://x.test/1?ref=abc'))).toBe('https://x.test/1');
    });

    it('returns null for an item with no usable url', () => {
        expect(markKey({ title: 'no link' })).toBeNull();
    });
});

describe('applyMarks', () => {
    const store: MarkStore = {
        'https://x.test/applied': { mark: 'applied', markedAt: '2026-08-01T00:00:00Z' },
        'https://x.test/ignored': { mark: 'ignored', markedAt: '2026-08-01T00:00:00Z' },
    };

    it('removes roles already applied to or dismissed', () => {
        const kept = applyMarks(
            [job('https://x.test/applied'), job('https://x.test/ignored'), job('https://x.test/new')],
            store,
        );
        expect(kept.items.map((i) => i.url)).toEqual(['https://x.test/new']);
    });

    it('reports how many it removed, so the count is not silently wrong', () => {
        const result = applyMarks([job('https://x.test/applied'), job('https://x.test/new')], store);
        expect(result.removed).toBe(1);
    });

    it('leaves everything alone when nothing is marked', () => {
        const items = [job('https://x.test/a'), job('https://x.test/b')];
        expect(applyMarks(items, {}).items).toHaveLength(2);
    });

    it('keeps an item with no url rather than dropping it', () => {
        // Losing a result because it lacks a link is worse than showing it.
        expect(applyMarks([{ title: 'no link' }], store).items).toHaveLength(1);
    });
});

describe('mergeMark', () => {
    it('records a new mark with a timestamp', () => {
        const store = mergeMark({}, 'https://x.test/1', 'applied', { title: 'Growth Lead' });
        expect(store['https://x.test/1'].mark).toBe('applied');
        expect(store['https://x.test/1'].title).toBe('Growth Lead');
        expect(Date.parse(store['https://x.test/1'].markedAt)).not.toBeNaN();
    });

    it('lets a later mark replace an earlier one', () => {
        // Ignoring a role then applying to it should end up applied.
        let store = mergeMark({}, 'https://x.test/1', 'ignored');
        store = mergeMark(store, 'https://x.test/1', 'applied');
        expect(store['https://x.test/1'].mark).toBe('applied');
    });

    it('normalises the url so a tracking parameter cannot create a duplicate', () => {
        const store = mergeMark({}, 'https://x.test/1?utm=x', 'applied');
        expect(Object.keys(store)).toEqual(['https://x.test/1']);
    });
});
