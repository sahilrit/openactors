import { openKeyValueStore } from '../storage.js';

/** Keys seen for one search, each mapped to when it was first seen. */
export type SeenMap = Record<string, string>;

export interface SearchState {
    seen: SeenMap;
    /**
     * When this search last completed. Tracked separately from `seen` because a
     * search can legitimately return nothing — filtered to zero, say — and
     * inferring "never run" from an empty seen-map would label it a first run
     * forever.
     */
    lastRunAt?: string;
}

export type DigestState = Record<string, SearchState>;

const STORE = 'digest-state';
const KEY = 'seen';

export async function loadState(): Promise<DigestState> {
    const store = await openKeyValueStore(STORE);
    const raw = (await store.getValue<Record<string, unknown>>(KEY)) ?? {};

    // Earlier runs stored a bare SeenMap per search. Read both shapes so an
    // existing state file is not silently discarded, which would report every
    // known item as new again.
    const state: DigestState = {};
    for (const [name, value] of Object.entries(raw)) {
        if (value && typeof value === 'object' && 'seen' in value) {
            state[name] = value as SearchState;
        } else {
            state[name] = { seen: (value ?? {}) as SeenMap };
        }
    }
    return state;
}

export async function saveState(state: DigestState): Promise<void> {
    const store = await openKeyValueStore(STORE);
    await store.setValue(KEY, state);
}

/**
 * Forgets keys first seen longer than `keepDays` ago.
 *
 * Without this the state grows without bound on a daily search. The window has
 * to be comfortably longer than a posting stays listed, or an old role would
 * fall out of memory and be reported as new again.
 */
export function prune(seen: SeenMap, keepDays: number, now: Date): SeenMap {
    const cutoff = now.getTime() - keepDays * 86_400_000;
    return Object.fromEntries(
        Object.entries(seen).filter(([, firstSeen]) => {
            const time = Date.parse(firstSeen);
            // An unparseable timestamp is kept: dropping it would resurface the
            // item as new, which is the worse failure.
            return Number.isNaN(time) || time >= cutoff;
        }),
    );
}

export interface DiffResult<T> {
    fresh: T[];
    /** Keys of items seen before, for reporting only. */
    repeatCount: number;
    updatedSeen: SeenMap;
}

/**
 * Splits items into those never seen for this search and those already known.
 * Items with no usable key are treated as new — under-reporting a genuinely new
 * role is worse than showing one twice.
 */
export function diff<T extends Record<string, unknown>>(
    items: T[],
    seen: SeenMap,
    keyField: string,
    now: Date,
): DiffResult<T> {
    const updatedSeen: SeenMap = { ...seen };
    const fresh: T[] = [];
    let repeatCount = 0;
    const stamp = now.toISOString();

    for (const item of items) {
        const raw = item[keyField];
        const key = typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : null;

        if (key === null) {
            fresh.push(item);
            continue;
        }
        if (key in seen) {
            repeatCount++;
            continue;
        }

        updatedSeen[key] = stamp;
        fresh.push(item);
    }

    return { fresh, repeatCount, updatedSeen };
}
