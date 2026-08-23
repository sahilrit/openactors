import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCards } from '../actors/linkedin/jobs/parse.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'linkedin-guest.html');
const html = readFileSync(FIXTURE, 'utf8');

/**
 * The fixture is a verbatim response from LinkedIn's public guest job-search
 * endpoint. LinkedIn restyles that page regularly, so these tests exist to make
 * a markup change fail loudly instead of silently returning empty results.
 */
describe('parseCards', () => {
    const jobs = parseCards(html);

    // LinkedIn's guest endpoint serves 10 postings per request. Consecutive
    // offsets were confirmed to return disjoint sets, so paging by the number
    // of cards received neither skips nor repeats.
    it('finds every card in the page', () => {
        expect(jobs.length).toBe(10);
    });

    it('extracts a title, company and url for every listing', () => {
        for (const job of jobs) {
            expect(job.title, JSON.stringify(job)).toBeTruthy();
            expect(job.company, JSON.stringify(job)).toBeTruthy();
            expect(job.url).toMatch(/^https:\/\/[a-z.]*linkedin\.com\/jobs\/view\//);
        }
    });

    it('strips tracking parameters, so pages deduplicate correctly', () => {
        for (const job of jobs) expect(job.url).not.toContain('?');
        expect(new Set(jobs.map((j) => j.url)).size).toBe(jobs.length);
    });

    it('reads the numeric posting id', () => {
        for (const job of jobs) expect(job.id, JSON.stringify(job)).toMatch(/^\d+$/);
    });

    it('normalizes the posted date to ISO', () => {
        const dated = jobs.filter((j) => j.postedAt !== null);
        expect(dated.length).toBeGreaterThan(0);
        for (const job of dated) {
            expect(job.postedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
            expect(Number.isNaN(Date.parse(job.postedAt!))).toBe(false);
        }
    });

    it('collapses whitespace in text pulled from the markup', () => {
        for (const job of jobs) {
            for (const field of [job.title, job.company, job.location]) {
                if (field !== null) expect(field).toBe(field.replace(/\s+/g, ' ').trim());
            }
        }
    });

    it('returns nothing rather than throwing on unrelated html', () => {
        expect(parseCards('<html><body><p>no jobs here</p></body></html>')).toEqual([]);
        expect(parseCards('')).toEqual([]);
    });

    it('skips a card with no job link instead of emitting a blank row', () => {
        expect(parseCards('<div class="base-card"><h3>Ghost role</h3></div>')).toEqual([]);
    });
});
