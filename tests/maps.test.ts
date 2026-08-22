import { describe, expect, it } from 'vitest';
import { parseCard } from '../actors/maps/google-maps/parse.js';

const URL = 'https://www.google.com/maps/place/x';

/**
 * Both fixtures below are verbatim card text captured from live Google Maps.
 * Maps varies its card rendering between queries, which is exactly the class of
 * change these tests exist to catch.
 */
describe('parseCard', () => {
    it('reads a card with category, address, hours and phone', () => {
        const job = parseCard('Reliant Plumbing - Austin', [
            'Reliant Plumbing - Austin',
            'Reliant Plumbing - Austin',
            '4.7',
            'Plumber · 12111 Menchaca Rd',
            'Open 24 hours · +1 512-675-4220',
            '',
            'Website',
            '',
            'Directions',
        ], URL);

        expect(job.name).toBe('Reliant Plumbing - Austin');
        expect(job.rating).toBe(4.7);
        expect(job.category).toBe('Plumber');
        expect(job.address).toBe('12111 Menchaca Rd');
        expect(job.phone).toBe('+1 512-675-4220');
        expect(job.hours).toBe('Open 24 hours');
        expect(job.hasWebsite).toBe(true);
    });

    it('reads a review count joined to the rating', () => {
        const job = parseCard('Beyond Wow Plumbing & Drains', [
            'Beyond Wow Plumbing & Drains',
            '4.9(2,565)',
            'Plumber · 3432 Greystone Dr',
            'Closed · Opens 7 am Mon · +1 512-601-6173',
        ], URL);

        expect(job.rating).toBe(4.9);
        expect(job.reviews).toBe(2565);
        expect(job.hours).toBe('Closed · Opens 7 am Mon');
        expect(job.phone).toBe('+1 512-601-6173');
    });

    it('reads a review count that sits on its own line', () => {
        const job = parseCard('X', ['X', '4.5', '(1,204)', 'Cafe · 1 High St'], URL);
        expect(job.reviews).toBe(1204);
        expect(job.category).toBe('Cafe');
    });

    it('keeps the category when a listing has no street address', () => {
        const job = parseCard('Plumb Masters, Inc.', [
            'Plumb Masters, Inc.',
            'Plumb Masters, Inc.',
            '4.8',
            'Plumber',
            'Open 24 hours · +1 512-960-0044',
            'Website',
        ], URL);

        expect(job.category).toBe('Plumber');
        expect(job.address).toBeNull();
        expect(job.phone).toBe('+1 512-960-0044');
    });

    it('returns nulls rather than guesses for a bare card', () => {
        const job = parseCard('Some Place', ['Some Place'], URL);
        expect(job.name).toBe('Some Place');
        expect(job.rating).toBeNull();
        expect(job.reviews).toBeNull();
        expect(job.category).toBeNull();
        expect(job.phone).toBeNull();
        expect(job.hasWebsite).toBe(false);
    });

    it('does not mistake a street number for a phone number', () => {
        const job = parseCard('Y', ['Y', '4.1', 'Bakery · 42 Short Rd'], URL);
        expect(job.phone).toBeNull();
        expect(job.address).toBe('42 Short Rd');
    });

    it('survives an empty card without throwing', () => {
        expect(() => parseCard(null, [], URL)).not.toThrow();
        expect(parseCard(null, [], URL).name).toBeNull();
    });
});
