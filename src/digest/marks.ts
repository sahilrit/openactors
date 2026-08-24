/**
 * Roles you have already applied to or dismissed.
 *
 * Without this a digest is a feed rather than a workflow: every role you have
 * decided about keeps reappearing, and the only way to remember your own
 * decisions is to remember them.
 */

export type Mark = 'applied' | 'ignored';

/** What came back, if anything. Absent means still waiting. */
export type Response = 'replied' | 'rejected' | 'interview' | 'offer';

export interface MarkRecord {
    mark: Mark;
    markedAt: string;
    title?: string;
    company?: string;
    response?: Response;
    respondedAt?: string;
    /** When it was last chased, so one silence is not chased weekly. */
    followedUpAt?: string;
}

export interface FollowUp {
    url: string;
    title?: string;
    company?: string;
    daysSince: number;
    lastFollowedUpDaysAgo: number | null;
}

export type MarkStore = Record<string, MarkRecord>;

/**
 * The identity of a role. Tracking parameters are stripped: the same posting
 * reached from two searches carries different query strings, and keying on the
 * raw URL would let one role be marked twice and still reappear.
 */
export function markKey(item: Record<string, unknown>): string | null {
    for (const field of ['url', 'applyUrl', 'mapsUrl']) {
        const value = item[field];
        if (typeof value === 'string' && /^https?:\/\//.test(value)) return value.split('?')[0];
    }
    return null;
}

export function applyMarks<T extends Record<string, unknown>>(
    items: T[],
    store: MarkStore,
): { items: T[]; removed: number } {
    if (Object.keys(store).length === 0) return { items, removed: 0 };

    const kept = items.filter((item) => {
        const key = markKey(item);
        // An item with no link cannot have been marked; dropping it would lose
        // a result for the sake of a decision that was never made.
        return key === null || !(key in store);
    });

    return { items: kept, removed: items.length - kept.length };
}

export function mergeMark(
    store: MarkStore,
    url: string,
    mark: Mark,
    details: { title?: string; company?: string } = {},
): MarkStore {
    const key = url.split('?')[0];
    return {
        ...store,
        [key]: {
            mark,
            markedAt: new Date().toISOString(),
            ...(details.title ? { title: details.title } : {}),
            ...(details.company ? { company: details.company } : {}),
        },
    };
}

/**
 * Applications that have gone quiet long enough to be worth chasing.
 *
 * The rules exist to avoid the two ways this goes wrong. Chasing someone who
 * already replied reads as not having read their message, so any response at
 * all — including a rejection — ends the chase. And chasing the same silence
 * every day is worse than never chasing, so a follow-up resets the clock.
 */
export function followUpsDue(store: MarkStore, afterDays: number, now = new Date()): FollowUp[] {
    const windowMs = afterDays * 86_400_000;

    return Object.entries(store)
        .filter(([, record]) => record.mark === 'applied' && !record.response)
        .map(([url, record]) => {
            const applied = Date.parse(record.markedAt);
            const chased = record.followedUpAt ? Date.parse(record.followedUpAt) : null;
            return { url, record, applied, chased };
        })
        // An unparseable date would otherwise produce a NaN age and sort
        // unpredictably; skipping is better than reporting nonsense.
        .filter(({ applied }) => !Number.isNaN(applied))
        .filter(({ applied, chased }) => {
            const since = chased !== null && !Number.isNaN(chased) ? chased : applied;
            return now.getTime() - since >= windowMs;
        })
        .map(({ url, record, applied, chased }) => ({
            url,
            title: record.title,
            company: record.company,
            daysSince: Math.floor((now.getTime() - applied) / 86_400_000),
            lastFollowedUpDaysAgo:
                chased !== null && !Number.isNaN(chased) ? Math.floor((now.getTime() - chased) / 86_400_000) : null,
        }))
        // Longest wait first: those are the ones going coldest.
        .sort((a, b) => b.daysSince - a.daysSince);
}

export function recordResponse(store: MarkStore, url: string, response: Response): MarkStore {
    const key = url.split('?')[0];
    const existing = store[key];
    // An unknown url means the application was never recorded; inventing a
    // record here would silently create an application that never happened.
    if (!existing) return store;

    return { ...store, [key]: { ...existing, response, respondedAt: new Date().toISOString() } };
}

export function recordFollowUp(store: MarkStore, urls: string[], now = new Date()): MarkStore {
    const updated = { ...store };
    for (const url of urls) {
        const key = url.split('?')[0];
        if (updated[key]) updated[key] = { ...updated[key], followedUpAt: now.toISOString() };
    }
    return updated;
}
