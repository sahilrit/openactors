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
describe.each(['greenhouse', 'lever', 'ashby', 'smartrecruiters'])('%s normalizer', (name) => {
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
    it('trusts an explicit provider flag over the location text', () => {
        // Ashby states isRemote; a location naming a city must not override it.
        const job = PROVIDERS.ashby.normalize(
            { id: '1', title: 'X', jobUrl: 'https://x.test/1', location: 'Berlin', isRemote: true },
            'acme',
        );
        expect(job.remote).toBe(true);
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
