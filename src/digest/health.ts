/**
 * Detects a search that has quietly stopped working.
 *
 * The failure this exists for: a scraper whose target changed returns zero
 * items, which in a digest is indistinguishable from a quiet week. The digest
 * keeps arriving, keeps looking healthy, and keeps saying nothing new — for as
 * long as nobody checks.
 *
 * Judgement is on *total items scraped*, not on how many were new. New
 * legitimately falls to zero once a search has caught up; total does not.
 */

export interface SearchHealth {
    /** Total items per run, oldest first. */
    yields: number[];
    lastTotal: number;
}

export type HealthStatus = 'ok' | 'suspicious' | 'broken';

export interface HealthVerdict {
    status: HealthStatus;
    reason: string;
}

/** Runs of history kept. Enough to establish a baseline, bounded so state cannot grow. */
const WINDOW = 20;

/** Below this fraction of the usual yield is a collapse rather than a quiet week. */
const COLLAPSE_RATIO = 0.2;

/** A baseline this small cannot distinguish a break from noise. */
const MIN_BASELINE = 5;

/** Nearest-rank percentile. */
function percentile(values: number[], p: number): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const rank = Math.max(1, Math.ceil(p * sorted.length));
    return sorted[rank - 1];
}

export function recordYield(health: SearchHealth, total: number): SearchHealth {
    const yields = [...health.yields, total].slice(-WINDOW);
    return { yields, lastTotal: total };
}

export function assessHealth(health: SearchHealth, total: number): HealthVerdict {
    const history = health.yields;

    // Too little history to have an opinion. Saying nothing beats guessing.
    if (history.length < 2) return { status: 'ok', reason: 'not enough history yet' };

    const productive = history.filter((n) => n > 0);

    // A search that has never returned anything is not broken — some watches
    // are legitimately empty most days, and alerting on those would train you
    // to ignore the alerts.
    if (productive.length === 0) return { status: 'ok', reason: 'this search has never returned results' };

    // The 75th percentile, which has to survive two opposite failure modes.
    //
    // A plain median lets a sustained breakage rewrite normal: once the broken
    // runs outnumber the healthy ones, the median sinks to meet them and the
    // alert vanishes exactly when it matters. Anchoring on the maximum fixes
    // that but hands the baseline to a single freak run, after which every
    // ordinary run looks like a collapse. The 75th percentile sits above a run
    // of bad values and below a lone spike.
    const baseline = percentile(productive, 0.75);
    if (baseline < MIN_BASELINE) return { status: 'ok', reason: 'baseline too small to judge' };

    if (total >= baseline * COLLAPSE_RATIO) {
        return { status: 'ok', reason: `${total} results against a usual ${baseline}` };
    }

    // Consecutive collapses are what separate a blip from a break — counted on
    // any collapsed run, not only exact zeroes. A parser that half-works
    // returns a trickle rather than nothing, and would otherwise sit at
    // "suspicious" indefinitely, which reads as noise and gets ignored.
    const threshold = baseline * COLLAPSE_RATIO;
    let consecutive = 1;
    for (let i = history.length - 1; i >= 0 && history[i] < threshold; i--) consecutive++;

    const described = total === 0 ? 'returned nothing' : `returned only ${total}`;

    if (consecutive >= 2) {
        return {
            status: 'broken',
            reason: `${described} for ${consecutive} runs running, against a usual ${baseline}`,
        };
    }

    return { status: 'suspicious', reason: `${described}, after averaging ${baseline}` };
}
