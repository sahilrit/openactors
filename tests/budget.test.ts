import { describe, expect, it } from 'vitest';
import { DAILY_CEILING, nextDelayMs, remaining, rollover } from '../actors/linkedin/jobs/budget.js';

/**
 * The budget is the mechanism that keeps a burner account from being
 * restricted, so its edges are worth pinning down: a stale counter that fails
 * to reset silently blocks all work, and one that resets too eagerly removes
 * the protection entirely.
 */
describe('daily budget', () => {
    it('starts fresh when there is no stored state', () => {
        expect(rollover(null, '2026-08-23')).toEqual({ date: '2026-08-23', used: 0 });
    });

    it('resets when the stored state is from an earlier day', () => {
        expect(rollover({ date: '2026-08-22', used: 80 }, '2026-08-23')).toEqual({ date: '2026-08-23', used: 0 });
    });

    it('preserves the count within the same day', () => {
        expect(rollover({ date: '2026-08-23', used: 12 }, '2026-08-23')).toEqual({ date: '2026-08-23', used: 12 });
    });

    it('reports what is left, and never a negative allowance', () => {
        expect(remaining({ date: 'd', used: 0 })).toBe(DAILY_CEILING);
        expect(remaining({ date: 'd', used: 30 })).toBe(DAILY_CEILING - 30);
        expect(remaining({ date: 'd', used: DAILY_CEILING })).toBe(0);
        // An over-count (a run interrupted mid-write) must clamp, not go negative.
        expect(remaining({ date: 'd', used: DAILY_CEILING + 25 })).toBe(0);
    });
});

describe('request pacing', () => {
    it('stays within the intended window', () => {
        expect(nextDelayMs(() => 0)).toBe(3000);
        expect(nextDelayMs(() => 1)).toBe(8000);
        expect(nextDelayMs(() => 0.5)).toBe(5500);
    });

    it('varies, so the rhythm is not machine-regular', () => {
        const values = new Set(Array.from({ length: 40 }, () => nextDelayMs()));
        expect(values.size).toBeGreaterThan(20);
    });
});
