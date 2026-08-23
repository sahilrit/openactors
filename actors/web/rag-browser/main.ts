import { JSDOM, VirtualConsole } from 'jsdom';
import { htmlToMarkdown } from '../../../src/extract.js';
import { RateLimiter, fetchText } from '../../../src/fetcher.js';
import type { ActorContext } from '../../../src/types.js';

interface Input {
    query?: string;
    urls?: string[];
    maxResults?: number;
    maxCharsPerPage?: number;
    fetchContent?: boolean;
}

interface SearchResult {
    url: string;
    title: string;
}

/** One second between requests to the same host — polite, and enough to stay unblocked. */
const limiter = new RateLimiter(1000);

interface Engine {
    name: string;
    host: string;
    url(query: string): string;
    /** Selected by stable attributes, never by build-hashed class names. */
    resultSelector: string;
    linkSelector: string;
    titleSelector?: string;
    /** Some engines wrap destinations in a redirector. */
    unwrap?(href: string): string;
}

const ENGINES: Engine[] = [
    {
        name: 'brave',
        host: 'search.brave.com',
        url: (q) => `https://search.brave.com/search?q=${encodeURIComponent(q)}`,
        // Brave's markup is Svelte-built and its class names carry per-deploy
        // hashes (`snippet svelte-jmfu5f`), so match on data-type instead.
        resultSelector: '[data-type="web"]',
        linkSelector: 'a[href^="http"]',
        titleSelector: '.title',
    },
    {
        name: 'duckduckgo',
        host: 'html.duckduckgo.com',
        url: (q) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`,
        resultSelector: '.result__body',
        linkSelector: 'a.result__a, a',
        // DuckDuckGo routes every result through //duckduckgo.com/l/?uddg=<encoded>.
        unwrap: (href) => {
            const match = href.match(/[?&]uddg=([^&]+)/);
            return match ? decodeURIComponent(match[1]) : href;
        },
    },
];

function parseResults(engine: Engine, html: string, limit: number): SearchResult[] {
    const doc = new JSDOM(html, { virtualConsole: new VirtualConsole() }).window.document;
    const results: SearchResult[] = [];
    const seen = new Set<string>();

    for (const node of doc.querySelectorAll(engine.resultSelector)) {
        const anchor = node.querySelector(engine.linkSelector);
        const raw = anchor?.getAttribute('href');
        if (!anchor || !raw) continue;

        const url = engine.unwrap ? engine.unwrap(raw) : raw;
        if (!/^https?:\/\//.test(url)) continue;
        // Drop the engine's own navigation and duplicate destinations.
        if (url.includes(engine.host) || /^https?:\/\/(search\.)?brave\.com/.test(url)) continue;
        if (seen.has(url)) continue;
        seen.add(url);

        const title = (
            (engine.titleSelector ? node.querySelector(engine.titleSelector)?.textContent : null) ??
            anchor.textContent ??
            ''
        )
            .trim()
            .replace(/\s+/g, ' ');

        results.push({ url, title: title || url });
        if (results.length >= limit) break;
    }

    return results;
}

/**
 * Searches, trying each engine until one yields results.
 *
 * A single free engine is not dependable: querying from one IP without a key
 * draws intermittent 429s, and each engine reshapes its markup on its own
 * schedule. Falling through to another engine turns both of those from a failed
 * run into a slower one.
 */
async function search(query: string, limit: number, ctx: ActorContext): Promise<SearchResult[]> {
    const problems: string[] = [];

    for (const engine of ENGINES) {
        if (ctx.signal.aborted) break;
        try {
            await limiter.take(engine.host);
            const { status, body } = await fetchText(engine.url(query), { signal: ctx.signal, session: ctx.runId });
            if (status !== 200) {
                problems.push(`${engine.name}: HTTP ${status}`);
                continue;
            }

            const results = parseResults(engine, body, limit);
            if (results.length === 0) {
                // Distinguishing these two matters: one is a query with no
                // matches, the other is markup we no longer understand.
                problems.push(`${engine.name}: 200 but no parseable results (markup may have changed, or this IP is throttled)`);
                continue;
            }

            ctx.log(`search via ${engine.name}: ${results.length} result(s)`);
            return results;
        } catch (err) {
            problems.push(`${engine.name}: ${(err as Error).message}`);
        }
    }

    throw new Error(`all search engines failed — ${problems.join('; ')}`);
}

export async function run(input: Input, ctx: ActorContext): Promise<void> {
    const { query, urls, maxResults = 5, maxCharsPerPage = 8000, fetchContent = true } = input;

    if (!query && (!urls || urls.length === 0)) {
        throw new Error('Provide either `query` to search, or `urls` to fetch directly.');
    }

    const targets: SearchResult[] = urls?.length
        ? urls.slice(0, maxResults).map((url) => ({ url, title: '' }))
        : await search(query!, maxResults, ctx);

    ctx.log(`${targets.length} target(s)${query ? ` for "${query}"` : ''}`);

    if (!fetchContent) {
        await ctx.pushData(targets.map((t, rank) => ({ rank: rank + 1, url: t.url, title: t.title, markdown: null })));
        return;
    }

    for (const [rank, target] of targets.entries()) {
        if (ctx.signal.aborted) {
            ctx.log('aborted; stopping');
            return;
        }

        try {
            const host = new URL(target.url).hostname;
            await limiter.take(host);

            const { status, body } = await fetchText(target.url, { signal: ctx.signal, session: ctx.runId });
            if (status !== 200) {
                ctx.log(`SKIP ${target.url} — HTTP ${status}`);
                continue;
            }

            const { title, markdown } = htmlToMarkdown(body, target.url);
            await ctx.pushData({
                rank: rank + 1,
                url: target.url,
                title: title || target.title,
                markdown: markdown.length > maxCharsPerPage ? `${markdown.slice(0, maxCharsPerPage)}…` : markdown,
                truncated: markdown.length > maxCharsPerPage,
                fetchedAt: new Date().toISOString(),
            });
            ctx.log(`fetched ${target.url} (${markdown.length} chars)`);
        } catch (err) {
            // One unreachable page should not lose the other results.
            ctx.log(`SKIP ${target.url} — ${(err as Error).message}`);
        }
    }
}
