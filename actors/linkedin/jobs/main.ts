import { launchBrowser } from '../../../src/fetcher.js';
import { openKeyValueStore } from '../../../src/storage.js';
import type { ActorContext } from '../../../src/types.js';
import { DAILY_CEILING, nextDelayMs, remaining, rollover, type BudgetState } from './budget.js';

interface Input {
    keywords: string;
    location?: string;
    remoteOnly?: boolean;
    postedWithinDays?: number;
    maxResults?: number;
}

/** Named store so the budget survives restarts and is shared by every run. */
const BUDGET_STORE = 'linkedin-budget';
const BUDGET_KEY = 'daily';

/**
 * LinkedIn's own job-search page. `f_TPR=r<seconds>` is its posted-within
 * filter and `f_WT=2` its remote filter — both are the parameters the site's
 * own UI sets.
 */
function searchUrl(input: Input, start: number): string {
    const params = new URLSearchParams({ keywords: input.keywords, start: String(start) });
    if (input.location) params.set('location', input.location);
    if (input.postedWithinDays) params.set('f_TPR', `r${input.postedWithinDays * 86_400}`);
    if (input.remoteOnly) params.set('f_WT', '2');
    return `https://www.linkedin.com/jobs/search/?${params.toString()}`;
}

export async function run(input: Input, ctx: ActorContext): Promise<void> {
    const cookie = process.env.LINKEDIN_BURNER_COOKIE;
    if (!cookie) {
        throw new Error(
            'LINKEDIN_BURNER_COOKIE is not set. Use the li_at cookie of a SEPARATE THROWAWAY ' +
                'LinkedIn account — never your main one. LinkedIn restricts accounts it detects scraping.',
        );
    }

    const { keywords, maxResults = 25 } = input;
    if (!keywords?.trim()) throw new Error('keywords is required');

    // Check the shared budget before opening a browser, so an exhausted day
    // costs nothing and cannot be spent by accident.
    const store = await openKeyValueStore(BUDGET_STORE);
    const today = new Date().toISOString().slice(0, 10);
    const budget: BudgetState = rollover((await store.getValue<BudgetState>(BUDGET_KEY)) ?? null, today);

    const allowance = Math.min(maxResults, remaining(budget));
    if (allowance <= 0) {
        throw new Error(
            `Daily LinkedIn budget exhausted (${budget.used}/${DAILY_CEILING} used on ${today}). ` +
                'This cap exists to keep the account from being restricted; it resets at UTC midnight.',
        );
    }
    if (allowance < maxResults) {
        ctx.log(`budget limits this run to ${allowance} of ${maxResults} requested (${budget.used}/${DAILY_CEILING} used today)`);
    }

    const browser = await launchBrowser();

    try {
        const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
        await context.addCookies([
            { name: 'li_at', value: cookie, domain: '.linkedin.com', path: '/', httpOnly: true, secure: true },
        ]);
        const page = await context.newPage();

        const seen = new Set<string>();
        let collected = 0;
        // LinkedIn pages job search results 25 at a time.
        for (let start = 0; collected < allowance; start += 25) {
            if (ctx.signal.aborted) break;

            // Spend the budget before navigating, not after. A request that
            // fails still reached LinkedIn, and the cap exists to protect the
            // account rather than to count successes.
            budget.used++;
            await store.setValue(BUDGET_KEY, budget);

            try {
                await page.goto(searchUrl(input, start), { waitUntil: 'domcontentloaded', timeout: 45_000 });
            } catch (err) {
                // An invalid or expired cookie makes LinkedIn bounce between
                // the login page and the destination until the browser gives
                // up, so a redirect loop means bad credentials — not a network
                // fault, and not something a retry would fix.
                if (/ERR_TOO_MANY_REDIRECTS/.test((err as Error).message)) {
                    throw new Error(
                        'LinkedIn redirected in a loop, which means the burner cookie is expired or invalid. ' +
                            'Log in as the burner account and copy a fresh li_at cookie into LINKEDIN_BURNER_COOKIE.',
                    );
                }
                throw err;
            }

            if (page.url().includes('/authwall') || page.url().includes('/login')) {
                throw new Error(
                    'LinkedIn served a login wall — the burner cookie is expired or invalid. ' +
                        'Copy a fresh li_at cookie into LINKEDIN_BURNER_COOKIE.',
                );
            }

            const cards = await page
                .locator('div.job-search-card, li div.base-card, [data-job-id]')
                .evaluateAll((nodes) =>
                    nodes.map((node) => ({
                        text: (node as HTMLElement).innerText ?? '',
                        href: node.querySelector('a[href*="/jobs/view/"]')?.getAttribute('href') ?? null,
                        posted: node.querySelector('time')?.getAttribute('datetime') ?? null,
                    })),
                )
                .catch(() => []);

            if (cards.length === 0) {
                ctx.log(`no listings parsed at start=${start}; stopping (LinkedIn may have changed its markup)`);
                break;
            }

            let addedThisPage = 0;
            for (const card of cards) {
                if (collected >= allowance) break;
                if (!card.href) continue;

                const url = card.href.split('?')[0];
                if (seen.has(url)) continue;
                seen.add(url);

                // Card text is "Title\nCompany\nLocation\n…" — read positionally
                // but tolerate missing lines rather than shifting fields.
                const lines = card.text.split('\n').map((l) => l.trim()).filter(Boolean);
                await ctx.pushData({
                    title: lines[0] ?? null,
                    company: lines[1] ?? null,
                    location: lines[2] ?? null,
                    postedAt: card.posted,
                    url,
                    scrapedAt: new Date().toISOString(),
                });
                collected++;
                addedThisPage++;
            }

            if (addedThisPage === 0) break; // no new listings; further pages repeat

            // Jittered pause: a machine-regular request rhythm is itself a signal.
            await page.waitForTimeout(nextDelayMs());
        }

        ctx.log(`finished: ${collected} listing(s); budget now ${budget.used}/${DAILY_CEILING} for ${today}`);
    } finally {
        await browser.close().catch(() => {});
    }
}
