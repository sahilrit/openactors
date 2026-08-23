import { describe, expect, it } from 'vitest';
import { Semaphore } from '../src/semaphore.js';

const settle = () => new Promise((r) => setTimeout(r, 5));

describe('Semaphore', () => {
    it('admits up to the limit without waiting', async () => {
        const slots = new Semaphore(2);
        await slots.acquire();
        await slots.acquire();
        expect(slots.inUse).toBe(2);
        expect(slots.queued).toBe(0);
    });

    it('queues callers beyond the limit', async () => {
        const slots = new Semaphore(1);
        const release = await slots.acquire();

        let admitted = false;
        void slots.acquire().then(() => (admitted = true));
        await settle();
        expect(admitted).toBe(false);
        expect(slots.queued).toBe(1);

        release();
        await settle();
        expect(admitted).toBe(true);
    });

    it('serves waiters in order, so a long run is not starved by quick ones', async () => {
        const slots = new Semaphore(1);
        const release = await slots.acquire();
        const order: number[] = [];

        for (const n of [1, 2, 3]) void slots.acquire().then((r) => { order.push(n); r(); });

        release();
        await settle();
        expect(order).toEqual([1, 2, 3]);
    });

    it('ignores a double release, which would otherwise inflate capacity', async () => {
        // Released twice, the limit drifts upward run by run until it no
        // longer limits anything.
        const slots = new Semaphore(1);
        const release = await slots.acquire();
        release();
        release();
        expect(slots.inUse).toBe(0);

        await slots.acquire();
        expect(slots.inUse).toBe(1);
    });

    it('never admits more than the limit under a burst', async () => {
        const slots = new Semaphore(3);
        let peak = 0;
        await Promise.all(
            Array.from({ length: 20 }, async () => {
                const release = await slots.acquire();
                peak = Math.max(peak, slots.inUse);
                await settle();
                release();
            }),
        );
        expect(peak).toBeLessThanOrEqual(3);
        expect(slots.inUse).toBe(0);
    });
});
