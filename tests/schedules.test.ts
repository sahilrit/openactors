import { describe, expect, it } from 'vitest';
import { nextRun, validateCron } from '../src/schedules.js';

const AT = (iso: string) => new Date(iso);

describe('cron handling', () => {
    it('computes the next firing', () => {
        expect(nextRun('0 */6 * * *', 'UTC', AT('2026-08-23T10:00:00Z'))?.toISOString()).toBe('2026-08-23T12:00:00.000Z');
    });

    it('respects a timezone', () => {
        // 09:00 in Kolkata is 03:30 UTC.
        expect(nextRun('0 9 * * *', 'Asia/Kolkata', AT('2026-08-23T00:00:00Z'))?.toISOString()).toBe(
            '2026-08-23T03:30:00.000Z',
        );
    });

    it('rejects an unparseable expression at save time', () => {
        // A schedule that silently never fires is much harder to notice than
        // one that refuses to be created.
        expect(validateCron('not a cron')).not.toBeNull();
        expect(nextRun('not a cron', 'UTC', new Date())).toBeNull();
    });

    it('accepts the common shapes', () => {
        for (const cron of ['*/5 * * * *', '0 0 * * 1', '30 6 1 * *', '0 */6 * * *']) {
            expect(validateCron(cron), cron).toBeNull();
        }
    });

    it('rolls over midnight rather than returning a past time', () => {
        const next = nextRun('0 2 * * *', 'UTC', AT('2026-08-23T23:00:00Z'));
        expect(next?.toISOString()).toBe('2026-08-24T02:00:00.000Z');
        expect(next!.getTime()).toBeGreaterThan(AT('2026-08-23T23:00:00Z').getTime());
    });
});
