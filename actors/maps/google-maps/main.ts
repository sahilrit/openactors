import type { Page } from 'playwright';
import { launchBrowser } from '../../../src/fetcher.js';
import type { ActorContext } from '../../../src/types.js';
import { parseCard, type MapsBusiness } from './parse.js';

interface Input {
    query: string;
    maxResults?: number;
    includeDetails?: boolean;
    language?: string;
}

const FEED = 'div[role="feed"]';
/** Result cards are the map links inside the feed; Google's class names are generated. */
const CARD = 'a[href*="/maps/place/"]';

async function dismissConsent(page: Page, ctx: ActorContext): Promise<void> {
    // Google shows a consent interstitial in some regions. The button text
    // varies, so match on several rather than one brittle selector.
    for (const label of ['Accept all', 'Reject all', 'I agree', 'Alle akzeptieren']) {
        const button = page.getByRole('button', { name: label });
        if (await button.count().catch(() => 0)) {
            await button.first().click({ timeout: 5000 }).catch(() => {});
            ctx.log(`dismissed consent dialog ("${label}")`);
            await page.waitForTimeout(1000);
            return;
        }
    }
}

/**
 * Scrolls the results feed until it holds enough cards or stops growing.
 *
 * Google Maps loads results lazily into a scrollable panel, so the count only
 * rises as the panel is scrolled. Stopping after several unproductive scrolls
 * matters as much as the target count — a search with few matches would
 * otherwise scroll until the run timed out.
 */
async function loadResults(page: Page, target: number, ctx: ActorContext): Promise<void> {
    let previous = 0;
    let unproductive = 0;

    while (unproductive < 3) {
        if (ctx.signal.aborted) return;

        const count = await page.locator(`${FEED} ${CARD}`).count().catch(() => 0);
        if (count >= target) return;

        if (count === previous) unproductive++;
        else unproductive = 0;
        previous = count;

        await page.locator(FEED).evaluate((el) => el.scrollBy(0, el.scrollHeight)).catch(() => {});
        await page.waitForTimeout(1200);
    }

    ctx.log(`feed stopped growing at ${previous} result(s)`);
}

export async function run(input: Input, ctx: ActorContext): Promise<void> {
    const { query, maxResults = 20, includeDetails = false, language = 'en' } = input;
    if (!query || query.trim() === '') throw new Error('query is required, e.g. "dentists in Austin, TX"');

    const browser = await launchBrowser();

    try {
        const page = await browser.newPage({
            locale: language,
            viewport: { width: 1400, height: 1000 },
        });

        const url = `https://www.google.com/maps/search/${encodeURIComponent(query)}?hl=${encodeURIComponent(language)}`;
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
        await dismissConsent(page, ctx);

        try {
            await page.waitForSelector(FEED, { timeout: 25_000 });
        } catch {
            throw new Error('the results feed never appeared — Google may have served a consent wall or a CAPTCHA to this IP');
        }

        await loadResults(page, maxResults, ctx);

        // The browser returns raw text only; parsing happens in Node, where it
        // can be unit-tested. It also sidesteps esbuild's keepNames transform,
        // which wraps named functions in a `__name` helper that does not exist
        // in the page context.
        const cards = await page.locator(`${FEED} ${CARD}`).evaluateAll((nodes) =>
            nodes.map((node) => ({
                aria: node.getAttribute('aria-label'),
                mapsUrl: (node as HTMLAnchorElement).href,
                lines: ((node.closest('div[jsaction]') ?? node.parentElement) as HTMLElement | null)?.innerText?.split('\n') ?? [],
            })),
        );

        let pushed = 0;

        for (const card of cards) {
            if (pushed >= maxResults || ctx.signal.aborted) break;

            const business: MapsBusiness = parseCard(card.aria, card.lines, card.mapsUrl);
            if (!business.name) continue;

            if (includeDetails && business.hasWebsite) {
                try {
                    await page.goto(card.mapsUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
                    await page.waitForTimeout(1200);
                    business.website = await page
                        .locator('a[data-item-id="authority"]')
                        .first()
                        .getAttribute('href', { timeout: 5000 })
                        .catch(() => null);
                } catch (err) {
                    // A listing that will not open must not lose the row we
                    // already have from the feed.
                    ctx.log(`details unavailable for "${business.name}": ${(err as Error).message.split('\n')[0]}`);
                }
            }

            await ctx.pushData({ ...business, scrapedAt: new Date().toISOString() });
            pushed++;
        }

        ctx.log(`finished: ${pushed} business(es) for "${query}"`);
    } finally {
        await browser.close().catch(() => {});
    }
}
