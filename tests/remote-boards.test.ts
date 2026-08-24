import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BOARDS } from '../actors/jobs/remote-boards/boards.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const load = (name: string) => JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8'));

/**
 * These boards exist to list work that is remote regardless of where you sit,
 * so the field that matters most is the one naming the restriction — a role
 * open "Worldwide" and one restricted to "USA" look identical otherwise.
 */
describe.each(['remoteok', 'remotive', 'himalayas'])('%s normalizer', (name) => {
    const job = BOARDS[name].normalize(load(name));

    it('reports its own board', () => {
        expect(job.board).toBe(name);
    });

    it('extracts a title and company', () => {
        expect(job.title).toBeTruthy();
        expect(job.company).toBeTruthy();
    });

    it('produces an absolute url', () => {
        expect(job.url).toMatch(/^https?:\/\//);
    });

    it('emits an ISO date or null, never an Invalid Date', () => {
        if (job.postedAt !== null) expect(Number.isNaN(Date.parse(job.postedAt))).toBe(false);
    });

    it('never emits an empty string where a value is absent', () => {
        for (const [key, value] of Object.entries(job)) {
            expect(value, `${key}`).not.toBe('');
        }
    });
});

describe('location restrictions', () => {
    it('reads Remotive\'s candidate_required_location', () => {
        expect(BOARDS.remotive.normalize({ title: 'X', company_name: 'C', url: 'https://x.test/1', candidate_required_location: 'USA' }).restriction)
            .toBe('USA');
    });

    it('joins Himalayas\' restriction array', () => {
        expect(BOARDS.himalayas.normalize({ title: 'X', companyName: 'C', applicationLink: 'https://x.test/1', locationRestrictions: ['Germany', 'Austria'] }).restriction)
            .toBe('Germany, Austria');
    });

    it('treats an empty Himalayas restriction as worldwide, which is what it means', () => {
        // The field is the whole point of the board: no restriction listed is
        // an explicit "anywhere", not missing data.
        expect(BOARDS.himalayas.normalize({ title: 'X', companyName: 'C', applicationLink: 'https://x.test/1', locationRestrictions: [] }).restriction)
            .toBe('Worldwide');
    });

    it('falls back to RemoteOK\'s free-text location', () => {
        expect(BOARDS.remoteok.normalize({ position: 'X', company: 'C', url: 'https://x.test/1', location: 'Worldwide' }).restriction)
            .toBe('Worldwide');
    });
});

describe('epoch dates', () => {
    it('reads Himalayas\' seconds-since-epoch', () => {
        expect(BOARDS.himalayas.normalize({ title: 'X', companyName: 'C', applicationLink: 'https://x.test/1', pubDate: 1787592596 }).postedAt)
            .toBe('2026-08-24T17:29:56.000Z');
    });
});

describe('malformed input', () => {
    it('degrades rather than throwing', () => {
        for (const name of Object.keys(BOARDS)) {
            expect(() => BOARDS[name].normalize({}), name).not.toThrow();
        }
    });

    it('extract returns an empty array for an unexpected envelope', () => {
        for (const name of Object.keys(BOARDS)) {
            expect(BOARDS[name].extract({}), name).toEqual([]);
        }
    });
});
