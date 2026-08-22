/**
 * A daily request budget, enforced in code rather than documented in a README.
 *
 * LinkedIn restricts accounts it detects scraping, and the commonly cited safe
 * ceiling for a warm account is 50–100 page views per day. A cap that lives in
 * prose gets ignored by whoever is in a hurry; this one is checked before every
 * request and persists across runs, so a burst of separate calls cannot add up
 * to a ban.
 */

export const DAILY_CEILING = 80;

export interface BudgetState {
    date: string;
    used: number;
}

/** Rolls the counter over at UTC midnight. */
export function rollover(state: BudgetState | null, today: string): BudgetState {
    if (!state || state.date !== today) return { date: today, used: 0 };
    return state;
}

export function remaining(state: BudgetState, ceiling = DAILY_CEILING): number {
    return Math.max(0, ceiling - state.used);
}

/** How long to wait before the next request, jittered so the rhythm isn't machine-regular. */
export function nextDelayMs(random: () => number = Math.random): number {
    const MIN = 3_000;
    const MAX = 8_000;
    return Math.round(MIN + random() * (MAX - MIN));
}
