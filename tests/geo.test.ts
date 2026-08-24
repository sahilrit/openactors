import { describe, expect, it } from 'vitest';
import { classifyEligibility } from '../src/geo.js';

/**
 * Every location string below was captured from a live board during
 * development — Greenhouse, Ashby, Lever, Recruitee and LinkedIn — rather than
 * invented, because the failure mode here is real strings that the classifier
 * has never seen.
 */
const IN = 'IN';

describe('classifyEligibility, for a candidate in India', () => {
    it.each([
        ['Remote, Canada; Remote, US', 'restricted'],
        ['U.S. Remote', 'restricted'],
        ['Remote U.S.', 'restricted'],
        ['North America', 'restricted'],
        ['Europe', 'restricted'],
        ['Remote - European Union', 'restricted'],
        ['San Francisco, CA', 'restricted'],
        ['Foster City, CA', 'restricted'],
        ['New York, NY (HQ)', 'restricted'],
        ['Sydney, Australia', 'restricted'],
        ['London, UK', 'restricted'],
        ['London Area, United Kingdom', 'restricted'],
        ['Greater London, England, United Kingdom', 'restricted'],
        ['Berlin, Berlin, Germany', 'restricted'],
        ['Utrecht, Utrecht, Netherlands', 'restricted'],
        ['Remote - Japan', 'restricted'],
        ['Poland, REMOTE, Poland', 'restricted'],
    ])('treats %s as %s', (location, expected) => {
        expect(classifyEligibility(location, IN).eligibility).toBe(expected);
    });

    it.each([
        ['Remote - Worldwide', 'open'],
        ['Anywhere', 'open'],
        ['Remote (Global)', 'open'],
        ['India', 'open'],
        ['Bengaluru, India', 'open'],
        ['Remote - APAC', 'open'],
        ['Asia Pacific', 'open'],
    ])('treats %s as %s', (location, expected) => {
        expect(classifyEligibility(location, IN).eligibility).toBe(expected);
    });

    it.each([
        ['Remote', 'unknown'],
        ['Remote job', 'unknown'],
        ['', 'unknown'],
    ])('treats %s as %s', (location, expected) => {
        expect(classifyEligibility(location, IN).eligibility).toBe(expected);
    });

    it('reports null location as unknown, never as open', () => {
        expect(classifyEligibility(null, IN).eligibility).toBe('unknown');
    });
});

describe('the candidate country matters', () => {
    it('opens US roles for a US candidate and closes them for an Indian one', () => {
        expect(classifyEligibility('Remote U.S.', 'US').eligibility).toBe('open');
        expect(classifyEligibility('Remote U.S.', 'IN').eligibility).toBe('restricted');
    });

    it('places Britain inside Europe but outside the EU list', () => {
        expect(classifyEligibility('Europe', 'GB').eligibility).toBe('open');
        expect(classifyEligibility('Remote - European Union', 'GB').eligibility).toBe('restricted');
    });
});

describe('on-site roles', () => {
    it('closes an on-site role abroad however its location reads', () => {
        expect(classifyEligibility('Remote-ish, London', 'IN', 'OnSite').eligibility).toBe('restricted');
    });

    it('keeps an on-site role in the candidate\'s own country', () => {
        expect(classifyEligibility('Bengaluru, India', 'IN', 'OnSite').eligibility).toBe('open');
    });
});

describe('word-boundary hazards', () => {
    it('does not read "us" out of Austin or campus', () => {
        expect(classifyEligibility('Austin', 'IN').territories).not.toContain('US');
        expect(classifyEligibility('On campus', 'IN').territories).not.toContain('US');
    });

    it('reads a bare IN token as the US state, not as India', () => {
        // "Indianapolis, IN" is Indiana. Treating it as India would hand an
        // Indian candidate a list of Midwest office jobs.
        expect(classifyEligibility('Indianapolis, IN', 'IN').eligibility).toBe('restricted');
    });

    it('explains itself', () => {
        expect(classifyEligibility('Remote U.S.', 'IN').reason).toMatch(/limited to/);
        expect(classifyEligibility('Anywhere', 'IN').reason).toMatch(/worldwide/);
    });
});

describe('labelling without filtering', () => {
    it('is what lets a restricted role still be seen and judged', () => {
        // Dropping every US-restricted role hides the ones whose posting is
        // stricter than the employer actually is. Labelling keeps the judgement
        // with the reader instead of making it silently on their behalf.
        const verdict = classifyEligibility('Remote U.S.', 'IN');
        expect(verdict.eligibility).toBe('restricted');
        expect(verdict.reason).toMatch(/limited to/);
    });
});
