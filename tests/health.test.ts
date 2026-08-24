import { describe, expect, it } from 'vitest';
import { assessHealth, recordYield, type SearchHealth } from '../src/digest/health.js';

const history = (yields: number[]): SearchHealth => ({ yields, lastTotal: yields.at(-1) ?? 0 });

/**
 * A search that breaks returns zero items, which is indistinguishable from a
 * quiet week unless you know what it normally returns. These tests pin down
 * that distinction, because getting it wrong means either silent breakage or
 * an alarm that cries wolf until it is ignored.
 */
describe('assessHealth', () => {
    it('is healthy when the yield holds steady', () => {
        expect(assessHealth(history([40, 40, 38, 41]), 40).status).toBe('ok');
    });

    it('is suspicious the first time a productive search returns nothing', () => {
        const verdict = assessHealth(history([40, 38, 41]), 0);
        expect(verdict.status).toBe('suspicious');
        expect(verdict.reason).toMatch(/0 .*after averaging|returned nothing/i);
    });

    it('is broken once a productive search returns nothing twice running', () => {
        expect(assessHealth(history([40, 38, 0]), 0).status).toBe('broken');
    });

    it('never flags a search that has always returned nothing', () => {
        // The "rare globally-open roles" watch is legitimately empty most days.
        // Alerting on it would train you to ignore the alerts.
        expect(assessHealth(history([0, 0, 0, 0]), 0).status).toBe('ok');
    });

    it('never flags a search with too little history to judge', () => {
        expect(assessHealth(history([]), 0).status).toBe('ok');
        expect(assessHealth(history([40]), 0).status).toBe('ok');
    });

    it('flags a collapse, not merely a dip', () => {
        // Half the usual yield is a quiet week; a twentieth is a broken parser.
        expect(assessHealth(history([40, 42, 38]), 20).status).toBe('ok');
        expect(assessHealth(history([40, 42, 38]), 2).status).toBe('suspicious');
    });

    it('escalates a persistent collapse, not only repeated zeroes', () => {
        // A search stuck at a fraction of its usual yield run after run is
        // broken. Only escalating on exact zeroes leaves a partly-broken
        // parser flagged as "suspicious" forever, which reads as noise.
        const first = assessHealth(history([40, 42, 38]), 7);
        expect(first.status).toBe('suspicious');
        const second = assessHealth(history([40, 42, 38, 7]), 7);
        expect(second.status).toBe('broken');
    });

    it('does not let a sustained breakage become the new normal', () => {
        // The trap: once broken runs outnumber healthy ones in the window, a
        // naive median treats the breakage as normal and the alert vanishes —
        // exactly when it matters most.
        expect(assessHealth(history([40, 42, 38, 7, 7, 7]), 7).status).toBe('broken');
        expect(assessHealth(history([40, 42, 38, 7, 7, 7, 7, 7]), 7).status).toBe('broken');
    });

    it('accepts a genuine gradual decline without crying wolf', () => {
        // A search whose market is simply quieter should not be flagged.
        expect(assessHealth(history([40, 32, 26, 20]), 18).status).toBe('ok');
    });

    it('recovers as soon as results return', () => {
        expect(assessHealth(history([40, 0, 0]), 39).status).toBe('ok');
    });

    it('judges against the median, so one outlier cannot set the baseline', () => {
        // A single 500-item run must not make 40 look like a collapse.
        expect(assessHealth(history([40, 500, 38, 41]), 40).status).toBe('ok');
    });
});

describe('recordYield', () => {
    it('appends the newest yield', () => {
        expect(recordYield(history([1, 2]), 3).yields).toEqual([1, 2, 3]);
    });

    it('keeps the window bounded so state cannot grow without limit', () => {
        let h = history([]);
        for (let i = 0; i < 50; i++) h = recordYield(h, i);
        expect(h.yields.length).toBeLessThanOrEqual(20);
        // The newest entries are the ones kept.
        expect(h.yields.at(-1)).toBe(49);
    });
});
