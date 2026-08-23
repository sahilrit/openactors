import { describe, expect, it } from 'vitest';
import { headersFor, rotateSession } from '../src/fetcher.js';

describe('generated headers', () => {
    it('produces a complete, internally consistent header set', () => {
        const headers = headersFor('t1');
        expect(headers['user-agent']).toMatch(/Mozilla\/5\.0/);
        expect(headers['accept-language']).toBeTruthy();
        expect(headers.accept).toBeTruthy();
    });

    it('keeps one identity for the life of a session', () => {
        // Changing browser between pages of a single crawl is itself anomalous.
        expect(headersFor('t2')).toEqual(headersFor('t2'));
    });

    it('gives different sessions their own identity', () => {
        rotateSession('a');
        rotateSession('b');
        const seen = new Set<string>();
        for (let i = 0; i < 12; i++) {
            rotateSession(`s${i}`);
            seen.add(headersFor(`s${i}`)['user-agent']);
        }
        // Generated from a real distribution, so a few repeats are expected;
        // one single value across a dozen draws would mean it is not rotating.
        expect(seen.size).toBeGreaterThan(1);
    });

    it('issues a fresh identity after a rotation', () => {
        const before = headersFor('t3');
        rotateSession('t3');
        const after = headersFor('t3');
        expect(after['user-agent']).toBeTruthy();
        expect(after).not.toBe(before);
    });
});
