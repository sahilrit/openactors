import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROVIDERS } from '../actors/jobs/ats-boards/providers.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const load = (name: string) => JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8'));

/**
 * Normalizers are pure functions over recorded real responses. They are the
 * component most likely to break silently — an ATS renaming a field turns every
 * job's title into "(untitled)" without any error — so they are the part that
 * earns unit tests.
 */
describe.each(['greenhouse', 'lever', 'ashby', 'smartrecruiters', 'recruitee'])('%s normalizer', (name) => {
    const job = PROVIDERS[name].normalize(load(name), 'acme');

    it('reports its own provider and the account it was asked for', () => {
        expect(job.ats).toBe(name);
        expect(job.account).toBe('acme');
    });

    it('extracts a real title rather than falling back', () => {
        expect(job.title).not.toBe('(untitled)');
        expect(job.title.length).toBeGreaterThan(2);
    });

    it('produces a usable id and an absolute url', () => {
        expect(job.id).toMatch(/\S/);
        expect(job.url).toMatch(/^https?:\/\//);
    });

    it('emits ISO dates or null, never an Invalid Date', () => {
        if (job.publishedAt !== null) {
            expect(job.publishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
            expect(Number.isNaN(Date.parse(job.publishedAt))).toBe(false);
        }
    });

    it('uses null rather than empty strings for absent fields', () => {
        for (const [key, value] of Object.entries(job)) {
            expect(value, `${key} should not be an empty string`).not.toBe('');
        }
    });
});

describe('remote detection', () => {
    it('trusts the typed workplace field over the location text', () => {
        const job = PROVIDERS.ashby.normalize(
            { id: '1', title: 'X', jobUrl: 'https://x.test/1', location: 'Berlin', workplaceType: 'Remote' },
            'acme',
        );
        expect(job.remote).toBe(true);
    });

    // Regression: Ashby's isRemote is true for hybrid roles too. Ramp's board
    // carries 123 isRemote:true postings of which only 16 are actually Remote,
    // so trusting it reported New York office jobs as remote.
    it('does not treat hybrid as remote, even when isRemote says true', () => {
        const job = PROVIDERS.ashby.normalize(
            {
                id: '1',
                title: 'Software Engineer, Growth Platform',
                jobUrl: 'https://x.test/1',
                location: 'New York, NY (HQ)',
                isRemote: true,
                workplaceType: 'Hybrid',
            },
            'acme',
        );
        expect(job.remote).toBe(false);
        expect(job.workplaceType).toBe('Hybrid');
    });

    it('treats onsite as not remote', () => {
        const job = PROVIDERS.ashby.normalize(
            { id: '1', title: 'X', jobUrl: 'https://x.test/1', location: 'SF', isRemote: true, workplaceType: 'OnSite' },
            'acme',
        );
        expect(job.remote).toBe(false);
    });

    it('falls back to the location when the workplace type is absent or unspecified', () => {
        const absent = PROVIDERS.ashby.normalize(
            { id: '1', title: 'X', jobUrl: 'https://x.test/1', location: 'Remote U.S.', isRemote: true },
            'acme',
        );
        const unspecified = PROVIDERS.lever.normalize(
            { id: 'a', text: 'X', hostedUrl: 'https://x.test/a', workplaceType: 'unspecified', categories: { location: 'Remote' } },
            'acme',
        );
        expect(absent.remote).toBe(true);
        expect(unspecified.remote).toBe(true);
    });

    it('infers from the location where no flag exists', () => {
        const remote = PROVIDERS.greenhouse.normalize(
            { id: 1, title: 'X', absolute_url: 'https://x.test/1', location: { name: 'Remote in the US' } },
            'acme',
        );
        const onsite = PROVIDERS.greenhouse.normalize(
            { id: 2, title: 'Y', absolute_url: 'https://x.test/2', location: { name: 'Singapore' } },
            'acme',
        );
        expect(remote.remote).toBe(true);
        expect(onsite.remote).toBe(false);
    });

    it('stays null when the location is unknown', () => {
        const job = PROVIDERS.greenhouse.normalize({ id: 3, title: 'Z', absolute_url: 'https://x.test/3' }, 'acme');
        expect(job.remote).toBeNull();
    });
});

describe('recruitee', () => {
    it('parses its non-ISO date stamp rather than dropping it', () => {
        const job = PROVIDERS.recruitee.normalize(
            { id: 1, title: 'X', careers_url: 'https://x.test/1', published_at: '2026-08-05 10:10:39 UTC' },
            'acme',
        );
        expect(job.publishedAt).toBe('2026-08-05T10:10:39.000Z');
    });

    it('reads the three independent workplace booleans in priority order', () => {
        const base = { id: 1, title: 'X', careers_url: 'https://x.test/1' };
        // hybrid is set on nearly every Recruitee posting, so remote wins.
        expect(PROVIDERS.recruitee.normalize({ ...base, remote: true, hybrid: true }, 'a').workplaceType).toBe('Remote');
        expect(PROVIDERS.recruitee.normalize({ ...base, remote: false, hybrid: true }, 'a').workplaceType).toBe('Hybrid');
        expect(PROVIDERS.recruitee.normalize({ ...base, remote: false, on_site: true, hybrid: true }, 'a').workplaceType).toBe('OnSite');
        expect(PROVIDERS.recruitee.normalize(base, 'a').workplaceType).toBeNull();
    });

    it('trusts its remote flag, which is accurate unlike Ashby\'s', () => {
        const base = { id: 1, title: 'X', careers_url: 'https://x.test/1', hybrid: true };
        expect(PROVIDERS.recruitee.normalize({ ...base, remote: false, location: 'Berlin, Germany' }, 'a').remote).toBe(false);
        expect(PROVIDERS.recruitee.normalize({ ...base, remote: true, location: 'Remote job' }, 'a').remote).toBe(true);
    });
});

describe('date handling', () => {
    it('reads Lever epoch milliseconds', () => {
        const job = PROVIDERS.lever.normalize(
            { id: 'a', text: 'X', hostedUrl: 'https://x.test/a', createdAt: 1553186035299 },
            'acme',
        );
        expect(job.publishedAt).toBe('2019-03-21T16:33:55.299Z');
    });

    it('returns null for an unparseable date instead of Invalid Date', () => {
        const job = PROVIDERS.ashby.normalize(
            { id: 'a', title: 'X', jobUrl: 'https://x.test/a', publishedAt: 'not-a-date' },
            'acme',
        );
        expect(job.publishedAt).toBeNull();
    });
});

describe('malformed input', () => {
    it('degrades to a thin record rather than throwing', () => {
        for (const name of Object.keys(PROVIDERS)) {
            expect(() => PROVIDERS[name].normalize({}, 'acme'), name).not.toThrow();
        }
    });

    it('extract() returns an empty array for an unexpected envelope', () => {
        for (const name of Object.keys(PROVIDERS)) {
            expect(PROVIDERS[name].extract({}), name).toEqual([]);
        }
    });
});


describe('excludeRestricted', () => {
    it('is a documented input on the ATS actor', async () => {
        // Guards the manifest and the implementation against drifting apart:
        // an input the schema rejects is unusable however well it is coded.
        const { readFile } = await import('node:fs/promises');
        const manifest = JSON.parse(
            await readFile(new URL('../actors/jobs/ats-boards/actor.json', import.meta.url), 'utf8'),
        );
        expect(manifest.input.properties.excludeRestricted).toBeDefined();
        expect(manifest.input.properties.excludeRestricted.default).toBe(true);
    });
});
