/**
 * Roles you have already applied to or dismissed.
 *
 * Without this a digest is a feed rather than a workflow: every role you have
 * decided about keeps reappearing, and the only way to remember your own
 * decisions is to remember them.
 */

export type Mark = 'applied' | 'ignored';

export interface MarkRecord {
    mark: Mark;
    markedAt: string;
    title?: string;
    company?: string;
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
