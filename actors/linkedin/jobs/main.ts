import { classifyEligibility } from '../../../src/geo.js';
import { RateLimiter, fetchText } from '../../../src/fetcher.js';
import type { ActorContext } from '../../../src/types.js';
import { parseCards } from './parse.js';

interface Input {
    keywords: string;
    location?: string;
    remoteOnly?: boolean;
    postedWithinDays?: number;
    maxResults?: number;
    eligibleFrom?: string;
    includeUnknownEligibility?: boolean;
}

const ENDPOINT = 'https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search';

/**
 * Three seconds between pages. No account is at risk here, but this is still
 * automated access to someone else's service, and LinkedIn answers a fast
 * sequence with 429s.
 */
const limiter = new RateLimiter(3000);

/** Bounds the walk when LinkedIn keeps returning pages that add nothing new. */
const MAX_BARREN_PAGES = 2;

function searchUrl(input: Input, start: number): string {
    const params = new URLSearchParams({
        keywords: input.keywords,
        location: input.location ?? 'Worldwide',
        start: String(start),
    });
    // f_TPR and f_WT are the parameters LinkedIn's own filter UI sets.
    if (input.postedWithinDays) params.set('f_TPR', `r${input.postedWithinDays * 86_400}`);
    if (input.remoteOnly) params.set('f_WT', '2');
    return `${ENDPOINT}?${params.toString()}`;
}

export async function run(input: Input, ctx: ActorContext): Promise<void> {
    const { keywords, maxResults = 50, eligibleFrom, includeUnknownEligibility = true } = input;
    if (!keywords?.trim()) throw new Error('keywords is required, e.g. "performance marketing manager"');

    const seen = new Set<string>();
    let collected = 0;
    let barren = 0;
    let start = 0;

    while (collected < maxResults && barren < MAX_BARREN_PAGES) {
        if (ctx.signal.aborted) {
            ctx.log('aborted; stopping');
            return;
        }

        await limiter.take('www.linkedin.com');

        let body: string;
        let status: number;
        try {
            ({ status, body } = await fetchText(searchUrl(input, start), { signal: ctx.signal, session: ctx.runId }));
        } catch (err) {
            ctx.log(`stopping at start=${start}: ${(err as Error).message}`);
            break;
        }

        if (status === 429) {
            ctx.log(`LinkedIn rate-limited this IP at start=${start}; stopping with ${collected} result(s)`);
            break;
        }
        if (status !== 200) {
            ctx.log(`stopping at start=${start}: HTTP ${status}`);
            break;
        }

        const cards = parseCards(body);
        if (cards.length === 0) {
            // Either the result set is exhausted or the markup changed. Saying
            // which is impossible from here, so say both.
            ctx.log(`no cards at start=${start} — end of results, or LinkedIn changed its markup`);
            break;
        }

        let added = 0;
        let filtered = 0;
        for (const job of cards) {
            if (collected >= maxResults) break;
            if (seen.has(job.url)) continue;
            seen.add(job.url);

            const row: Record<string, unknown> = { ...job, scrapedAt: new Date().toISOString() };

            if (eligibleFrom) {
                const verdict = classifyEligibility(job.location, eligibleFrom);
                if (verdict.eligibility === 'restricted') { filtered++; continue; }
                if (verdict.eligibility === 'unknown' && !includeUnknownEligibility) { filtered++; continue; }
                row.eligibility = verdict.eligibility;
                row.eligibilityReason = verdict.reason;
            }

            await ctx.pushData(row);
            collected++;
            added++;
        }
        if (filtered > 0) ctx.log(`start=${start}: ${filtered} listing(s) dropped as not open from ${eligibleFrom}`);

        // Pages overlap: LinkedIn returns ~30 cards for a page size of 25, so
        // advancing by what arrived keeps the walk from re-reading the seam.
        start += cards.length;
        barren = added === 0 ? barren + 1 : 0;
        ctx.log(`start=${start - cards.length}: ${cards.length} card(s), ${added} new (total ${collected})`);
    }

    ctx.log(`finished: ${collected} listing(s) for "${keywords}"`);
}
