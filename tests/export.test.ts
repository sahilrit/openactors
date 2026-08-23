import { describe, expect, it } from 'vitest';
import { columnsOf, exportItems, project, toCsv, toRss, toXml } from '../src/export.js';

const ITEMS = [
    { title: 'Growth Lead', company: 'Acme', '#debug': 'internal', url: 'https://x.test/1' },
    { title: 'Paid Media', company: 'Beta', '#debug': 'internal', url: 'https://x.test/2', extra: 7 },
];

describe('project', () => {
    it('keeps only the requested fields, in the requested order', () => {
        expect(project(ITEMS, { fields: ['company', 'title'] })[0]).toEqual({ company: 'Acme', title: 'Growth Lead' });
    });

    it('drops omitted fields', () => {
        expect(project(ITEMS, { omit: ['url', '#debug'] })[0]).toEqual({ title: 'Growth Lead', company: 'Acme' });
    });

    it('lets omit win over fields, as Apify does', () => {
        expect(project(ITEMS, { fields: ['title', 'company'], omit: ['company'] })[0]).toEqual({ title: 'Growth Lead' });
    });

    it('drops #-prefixed debug fields when cleaning', () => {
        expect(Object.keys(project(ITEMS, { clean: true })[0])).not.toContain('#debug');
    });

    it('skips a requested field an item does not have, rather than emitting undefined', () => {
        expect(project(ITEMS, { fields: ['title', 'extra'] })[0]).toEqual({ title: 'Growth Lead' });
    });

    it('returns the input untouched when nothing is asked for', () => {
        expect(project(ITEMS)).toBe(ITEMS);
    });
});

describe('columnsOf', () => {
    it('unions keys across items, since a later row may add a field', () => {
        expect(columnsOf(ITEMS)).toContain('extra');
    });

    it('honours an explicit field list verbatim', () => {
        expect(columnsOf(ITEMS, ['b', 'a'])).toEqual(['b', 'a']);
    });
});

describe('toCsv', () => {
    it('quotes and escapes per RFC 4180', () => {
        const csv = toCsv([{ a: 'x,y', b: 'he said "hi"', c: 'line\nbreak' }]);
        expect(csv).toContain('"x,y"');
        expect(csv).toContain('"he said ""hi"""');
        expect(csv).toContain('"line\nbreak"');
    });

    it('renders null and undefined as empty, not as the words', () => {
        expect(toCsv([{ a: null, b: undefined }])).toBe('a,b\n,\n');
    });

    it('serializes nested values as JSON rather than [object Object]', () => {
        expect(toCsv([{ a: { deep: 1 } }])).toContain('{""deep"":1}');
    });

    it('ends with a newline, which readers expect of a complete file', () => {
        expect(toCsv([{ a: 1 }]).endsWith('\n')).toBe(true);
    });
});

describe('toXml', () => {
    it('escapes markup so a value cannot break the document', () => {
        expect(toXml([{ a: '<b>&"' }])).toContain('&lt;b&gt;&amp;&quot;');
    });

    it('rewrites keys that are not valid element names', () => {
        const xml = toXml([{ '#debug': 1, '2nd': 2 }]);
        expect(xml).toContain('<_debug>');
        expect(xml).toContain('<_2nd>');
    });
});

describe('toRss', () => {
    it('finds a title, link and date without configuration', () => {
        const rss = toRss([{ title: 'Growth Lead', url: 'https://x.test/1', postedAt: '2026-08-11T00:00:00.000Z' }]);
        expect(rss).toContain('<title>Growth Lead</title>');
        expect(rss).toContain('<link>https://x.test/1</link>');
        expect(rss).toMatch(/<pubDate>.*2026/);
    });

    it('still produces a valid item when nothing recognisable is present', () => {
        const rss = toRss([{ whatever: 1 }]);
        expect(rss).toContain('<title>Untitled</title>');
        // The channel always carries a link; the item should omit its own
        // rather than emit an empty one.
        const item = rss.slice(rss.indexOf('<item>'), rss.indexOf('</item>'));
        expect(item).not.toContain('<link>');
        expect(item).not.toContain('<guid');
    });
});

describe('exportItems', () => {
    it.each(['json', 'jsonl', 'csv', 'xml', 'html', 'rss'] as const)('produces text for %s', async (format) => {
        const out = await exportItems(ITEMS, format);
        expect(typeof out).toBe('string');
        expect((out as string).length).toBeGreaterThan(0);
    });

    it('produces a real xlsx workbook, not a JSON stand-in', async () => {
        const out = (await exportItems(ITEMS, 'xlsx')) as Buffer;
        expect(Buffer.isBuffer(out)).toBe(true);
        // XLSX is a zip; "PK" is the local file header magic.
        expect(out.subarray(0, 2).toString('latin1')).toBe('PK');
    });

    it('emits one line per item for jsonl', async () => {
        const out = (await exportItems(ITEMS, 'jsonl')) as string;
        expect(out.trim().split('\n')).toHaveLength(2);
        expect(() => JSON.parse(out.trim().split('\n')[0])).not.toThrow();
    });

    it('applies projection before formatting', async () => {
        const csv = (await exportItems(ITEMS, 'csv', { fields: ['title'] })) as string;
        expect(csv.split('\n')[0]).toBe('title');
    });

    it('handles an empty dataset without producing malformed output', async () => {
        expect(await exportItems([], 'jsonl')).toBe('');
        expect(JSON.parse((await exportItems([], 'json')) as string)).toEqual([]);
    });
});
