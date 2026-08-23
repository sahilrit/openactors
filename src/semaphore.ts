/**
 * Bounds how many Actors run at once.
 *
 * This became necessary the moment Actors moved into child processes: each run
 * is now a real OS process with its own heap ceiling, so an unbounded burst —
 * a scheduler firing several searches while an agent calls a few more — can
 * exhaust the machine rather than merely slowing it down.
 *
 * Waiters are served first-come-first-served. Fairness matters here because
 * the alternative is a long crawl repeatedly losing its slot to quick runs and
 * never finishing.
 */
export class Semaphore {
    private active = 0;
    private readonly waiting: Array<() => void> = [];

    constructor(private readonly limit: number) {}

    get inUse(): number {
        return this.active;
    }

    get queued(): number {
        return this.waiting.length;
    }

    get capacity(): number {
        return this.limit;
    }

    /** Resolves when a slot is free. The caller must release it exactly once. */
    async acquire(): Promise<() => void> {
        if (this.active < this.limit) {
            this.active++;
            return this.releaseOnce();
        }

        await new Promise<void>((resolve) => this.waiting.push(resolve));
        this.active++;
        return this.releaseOnce();
    }

    /**
     * Guards against a double release, which would inflate capacity silently —
     * the limit would drift upward run by run until it stopped limiting.
     */
    private releaseOnce(): () => void {
        let released = false;
        return () => {
            if (released) return;
            released = true;
            this.active--;
            this.waiting.shift()?.();
        };
    }
}
