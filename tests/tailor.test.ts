import { describe, expect, it } from 'vitest';
import { scoreBullets, extractSignals } from '../actors/jobs/tailor-application/select.js';

const BULLETS = [
    { role: 'presha', tags: ['meta', 'spend', 'media-buying'], text: 'Managed $1.4–2.2M in annual Meta spend.' },
    { role: 'presha', tags: ['leadership', 'team'], text: 'Led a team of 8 media buyers.' },
    { role: 'presha', tags: ['shopify', 'landing-page', 'cro'], text: 'Built Shopify landing pages.' },
    { role: 'performup', tags: ['lead-gen', 'cpl'], text: 'Generated 1,500+ leads per month.' },
];

describe('extractSignals', () => {
    it('picks out the platforms and disciplines a posting names', () => {
        const s = extractSignals('We need someone strong in Meta Ads and Shopify to lead our media buying.');
        expect(s).toContain('meta');
        expect(s).toContain('shopify');
        expect(s).toContain('media-buying');
    });

    it('recognises a discipline written differently from the tag', () => {
        // Postings say "conversion rate optimisation", the tag is "cro".
        expect(extractSignals('Own conversion rate optimisation across our funnel.')).toContain('cro');
        expect(extractSignals('You will manage people and mentor juniors.')).toContain('leadership');
    });

    it('returns nothing for a posting with no recognisable signal', () => {
        expect(extractSignals('We are a friendly team who value curiosity.')).toEqual([]);
    });

    it('is not fooled by a word appearing inside another', () => {
        // "metadata" must not read as "Meta".
        expect(extractSignals('Maintain campaign metadata in the warehouse.')).not.toContain('meta');
    });
});

describe('scoreBullets', () => {
    it('ranks bullets matching the posting above ones that do not', () => {
        const ranked = scoreBullets(BULLETS, ['meta', 'spend']);
        expect(ranked[0].text).toMatch(/Meta spend/);
    });

    it('keeps every bullet, so nothing true is discarded — only reordered', () => {
        // Tailoring is emphasis, not omission: a strong bullet the posting did
        // not mention still belongs on the resume.
        expect(scoreBullets(BULLETS, ['meta'])).toHaveLength(BULLETS.length);
    });

    it('is stable when a posting matches nothing', () => {
        expect(scoreBullets(BULLETS, []).map((b) => b.text)).toEqual(BULLETS.map((b) => b.text));
    });

    it('scores a bullet matching two signals above one matching one', () => {
        const ranked = scoreBullets(BULLETS, ['shopify', 'cro', 'lead-gen']);
        expect(ranked[0].text).toMatch(/Shopify/);
    });

    it('does not invent bullets that were not supplied', () => {
        // The guard that matters most: a resume may only contain what the
        // profile already asserts.
        const texts = new Set(BULLETS.map((b) => b.text));
        for (const b of scoreBullets(BULLETS, ['meta', 'shopify'])) expect(texts.has(b.text)).toBe(true);
    });
});
