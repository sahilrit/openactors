import { describe, expect, it } from 'vitest';
import { classifyWorkplace } from '../actors/jobs/verify-remote/classify.js';

/**
 * These postings all arrived tagged "remote" by LinkedIn's own filter. The
 * question is only whether their text agrees, so a phrase that contradicts the
 * tag has to outrank a generic mention of the word "remote" — otherwise almost
 * everything reads as remote and the check is worthless.
 */
describe('classifyWorkplace', () => {
    it('confirms an explicitly remote role', () => {
        const v = classifyWorkplace('This is a fully remote position, work from anywhere in India.');
        expect(v.verdict).toBe('remote');
        expect(v.evidence).toMatch(/fully remote/i);
    });

    it('catches hybrid, even alongside the word remote', () => {
        // "Remote" appears, but hybrid is the operative term.
        const v = classifyWorkplace('We offer a hybrid model with remote flexibility, 3 days in office.');
        expect(v.verdict).toBe('hybrid');
    });

    it('catches an on-site requirement', () => {
        expect(classifyWorkplace('Candidate must work from our Gurugram office daily.').verdict).toBe('onsite');
        expect(classifyWorkplace('This is a work from office (WFO) role.').verdict).toBe('onsite');
    });

    it('catches a relocation requirement', () => {
        const v = classifyWorkplace('Applicants must be willing to relocate to Bengaluru.');
        expect(v.verdict).toBe('onsite');
        expect(v.evidence).toMatch(/relocate/i);
    });

    it('is unclear when the text says nothing either way', () => {
        expect(classifyWorkplace('We are hiring a performance marketer to run Meta and Google campaigns.').verdict)
            .toBe('unclear');
    });

    it('is unclear on an empty description rather than guessing', () => {
        expect(classifyWorkplace('').verdict).toBe('unclear');
    });

    it('does not read "remote" out of an unrelated word', () => {
        // "remotely possible" is not a work arrangement.
        expect(classifyWorkplace('It is remotely possible that targets shift each quarter.').verdict).toBe('unclear');
    });

    it('quotes the phrase it decided on, so the verdict can be checked', () => {
        const v = classifyWorkplace('Great team. This role is 100% remote. Apply now.');
        expect(v.evidence).toContain('100% remote');
        expect(v.evidence.length).toBeLessThan(200);
    });

    it('does not mistake on-site SEO for an office requirement', () => {
        // "on-site SEO" is a marketing term. Reading it as a workplace signal
        // marks remote marketing roles as office-based — the exact population
        // this tool is pointed at.
        const v = classifyWorkplace('Manage on-site SEO and on-page optimisation across the funnel. Fully remote team.');
        expect(v.verdict).toBe('remote');
    });

    it('reads a negated arrangement as its opposite', () => {
        // "NO Hybrid model / NO Work from home" means office-based, and taking
        // the words at face value inverts the answer.
        const v = classifyWorkplace('Employment Type: Full Time, NO Hybrid model / NO Work from home. Location: Gurgaon.');
        expect(v.verdict).toBe('onsite');
    });

    it('still catches a genuine hybrid mention', () => {
        expect(classifyWorkplace('This is a hybrid role, 3 days in office.').verdict).toBe('hybrid');
    });

    it('prefers the most restrictive signal when several appear', () => {
        const v = classifyWorkplace('Work from home available. Hybrid: 2 days from our Mumbai office.');
        expect(v.verdict).toBe('hybrid');
    });
});
