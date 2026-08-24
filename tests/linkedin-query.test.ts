import { describe, expect, it } from 'vitest';
import { buildSearchUrl, JOB_TYPE_CODES } from '../actors/linkedin/jobs/query.js';

const params = (url: string) => new URL(url).searchParams;

describe('buildSearchUrl', () => {
    it('carries the keywords, location and offset', () => {
        const p = params(buildSearchUrl({ keywords: 'paid media', location: 'India' }, 20));
        expect(p.get('keywords')).toBe('paid media');
        expect(p.get('location')).toBe('India');
        expect(p.get('start')).toBe('20');
    });

    it('asks for remote roles with the parameter LinkedIn s own filter uses', () => {
        expect(params(buildSearchUrl({ keywords: 'x', remoteOnly: true }, 0)).get('f_WT')).toBe('2');
        expect(params(buildSearchUrl({ keywords: 'x' }, 0).toString()).get('f_WT')).toBeNull();
    });

    it('converts a posted-within window into seconds', () => {
        expect(params(buildSearchUrl({ keywords: 'x', postedWithinDays: 1 }, 0)).get('f_TPR')).toBe('r86400');
        expect(params(buildSearchUrl({ keywords: 'x', postedWithinDays: 7 }, 0)).get('f_TPR')).toBe('r604800');
    });

    it('repeats the parameter rather than joining codes with a comma', () => {
        // A comma-joined value is percent-encoded by URLSearchParams, and
        // LinkedIn silently ignores the encoded form — returning unfiltered
        // results that look exactly like a working filter.
        const p = params(buildSearchUrl({ keywords: 'x', jobTypes: ['contract', 'temporary'] }, 0));
        expect(p.getAll('f_JT')).toEqual(['C', 'T']);
    });

    it('never emits an encoded comma in the filter', () => {
        const url = buildSearchUrl({ keywords: 'x', jobTypes: ['contract', 'temporary', 'part-time'] }, 0);
        expect(url).not.toContain('%2C');
    });

    it('accepts freelance as an alias for contract', () => {
        expect(params(buildSearchUrl({ keywords: 'x', jobTypes: ['freelance'] }, 0)).getAll('f_JT')).toEqual(['C']);
    });

    it('ignores an unknown job type rather than sending a bad filter', () => {
        // A junk code makes LinkedIn return nothing, which would look exactly
        // like a market with no jobs in it.
        expect(params(buildSearchUrl({ keywords: 'x', jobTypes: ['contract', 'nonsense'] as never }, 0)).getAll('f_JT'))
            .toEqual(['C']);
    });

    it('omits the filter entirely when no type is asked for', () => {
        expect(params(buildSearchUrl({ keywords: 'x' }, 0)).get('f_JT')).toBeNull();
    });

    it('deduplicates codes so freelance and contract together stay one code', () => {
        expect(params(buildSearchUrl({ keywords: 'x', jobTypes: ['freelance', 'contract'] }, 0)).getAll('f_JT')).toEqual(['C']);
    });

    it('covers every documented type', () => {
        expect(Object.keys(JOB_TYPE_CODES).sort()).toEqual(
            ['contract', 'freelance', 'full-time', 'internship', 'part-time', 'temporary'].sort(),
        );
    });
});
