import { describe, expect, it } from 'vitest';
import { parseIntParam } from '../src/rest.js';

describe('parseIntParam', () => {
    // Regression: Number(null) is 0, not NaN, so an absent parameter used to
    // clamp to `min` instead of falling back. Every unspecified `limit` became 1
    // and every unspecified `timeout` became 5 seconds.
    it('falls back when the parameter is absent', () => {
        expect(parseIntParam(null, 1000, 1, 100_000)).toBe(1000);
        expect(parseIntParam(null, 300, 5, 3600)).toBe(300);
    });

    it('falls back on an empty or whitespace value', () => {
        expect(parseIntParam('', 1000, 1, 100_000)).toBe(1000);
        expect(parseIntParam('   ', 1000, 1, 100_000)).toBe(1000);
    });

    it('falls back on a non-numeric value', () => {
        expect(parseIntParam('abc', 50, 1, 500)).toBe(50);
    });

    it('honours an explicit zero rather than treating it as absent', () => {
        expect(parseIntParam('0', 60, 0, 600)).toBe(0);
    });

    it('clamps to the allowed range and truncates', () => {
        expect(parseIntParam('999999', 1000, 1, 100_000)).toBe(100_000);
        expect(parseIntParam('-5', 1000, 1, 100_000)).toBe(1);
        expect(parseIntParam('12.9', 1000, 1, 100_000)).toBe(12);
    });
});
