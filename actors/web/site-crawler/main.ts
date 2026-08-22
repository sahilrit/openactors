import { CheerioCrawler } from '@crawlee/cheerio';
import { RequestQueue } from '@crawlee/core';
import { Readability } from '@mozilla/readability';
import { JSDOM, VirtualConsole } from 'jsdom';
import TurndownService from 'turndown';
import type { ActorContext } from '../../../src/types.js';

interface Input {
    startUrls: string[];
    maxPages?: number;
    maxDepth?: number;
    sameDomainOnly?: boolean;
    includeUrlPattern?: string;
}

const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
// Keep the text, drop the chrome. These never carry article content.
turndown.remove(['script', 'style', 'nav', 'footer', 'noscript', 'iframe', 'form']);

/**
 * Extracts the main article from a page and converts it to Markdown.
 *
 * Readability is the same engine behind Firefox Reader Mode: it scores DOM
 * nodes by text density to find the content well, which is what removes
 * navigation and sidebars without per-site rules. When it finds nothing
 * article-shaped (a link hub, a landing page) we fall back to the whole body
 * rather than returning an empty string.
 */
function htmlToMarkdown(html: string, url: string): { title: string; markdown: string } {
    // jsdom logs every CSS parse error on real-world pages; that noise would
    // otherwise land on stderr and corrupt the MCP stdio channel.
    const virtualConsole = new VirtualConsole();
    const dom = new JSDOM(html, { url, virtualConsole });

    let title = dom.window.document.title ?? '';
    let contentHtml: string;

    try {
        const article = new Readability(dom.window.document.cloneNode(true) as Document).parse();
        if (article?.content && article.content.length > 200) {
            contentHtml = article.content;
            title = article.title || title;
        } else {
            contentHtml = dom.window.document.body?.innerHTML ?? '';
        }
    } catch {
        contentHtml = dom.window.document.body?.innerHTML ?? '';
    }

    const markdown = turndown
        .turndown(contentHtml)
        .replace(/\n{3,}/g, '\n\n')
        .trim();

    return { title: title.trim(), markdown };
}

export async function run(input: Input, ctx: ActorContext): Promise<void> {
    const {
        startUrls,
        maxPages = 10,
        maxDepth = 1,
        sameDomainOnly = true,
        includeUrlPattern,
    } = input;

    if (!Array.isArray(startUrls) || startUrls.length === 0) {
        throw new Error('startUrls must be a non-empty array of URLs');
    }

    const includeRe = includeUrlPattern ? new RegExp(includeUrlPattern) : undefined;
    const allowedHosts = new Set(startUrls.map((u) => new URL(u).hostname));

    // A queue of this run's own, not Crawlee's shared default. The default
    // queue persists across runs (we keep purgeOnStart off so datasets survive
    // for later reads), which would make every crawl after the first see its
    // URLs as already handled and return nothing.
    const requestQueue = await RequestQueue.open(`${ctx.runId}-requests`);

    const crawler = new CheerioCrawler({
        requestQueue,
        // Crawlee persists run statistics to the default key-value store under
        // an id that restarts at 0 with each process. A second server process
        // would therefore load the *previous* run's finished-request count,
        // find maxRequestsPerCrawl already satisfied, and stop before fetching
        // a single page. Each run's statistics must start from zero.
        statisticsOptions: { persistenceOptions: { enable: false } },
        maxRequestsPerCrawl: maxPages,
        maxConcurrency: 5,
        requestHandlerTimeoutSecs: 30,
        // One retry is enough for a transient blip; more just burns time on a
        // page that is genuinely blocked or gone.
        maxRequestRetries: 1,

        async requestHandler({ request, body, enqueueLinks, response }) {
            if (ctx.signal.aborted) return;

            const html = typeof body === 'string' ? body : body.toString('utf8');
            const { title, markdown } = htmlToMarkdown(html, request.url);

            await ctx.pushData({
                url: request.url,
                title,
                markdown,
                statusCode: response?.statusCode ?? null,
                depth: request.userData?.depth ?? 0,
                crawledAt: new Date().toISOString(),
            });
            ctx.log(`crawled ${request.url} (${markdown.length} chars)`);

            const depth = Number(request.userData?.depth ?? 0);
            if (depth >= maxDepth) return;

            await enqueueLinks({
                strategy: sameDomainOnly ? 'same-hostname' : 'all',
                userData: { depth: depth + 1 },
                transformRequestFunction(req) {
                    if (includeRe && !includeRe.test(req.url)) return false;
                    if (sameDomainOnly && !allowedHosts.has(new URL(req.url).hostname)) return false;
                    return req;
                },
            });
        },

        failedRequestHandler({ request }, error) {
            ctx.log(`FAILED ${request.url}: ${error.message}`);
        },
    });

    try {
        await crawler.run(startUrls.map((url) => ({ url, userData: { depth: 0 } })));
        ctx.log(`finished: ${startUrls.length} start URL(s), max ${maxPages} pages`);
    } finally {
        // Results live in the dataset; the queue is scratch. Dropping it keeps
        // storage/ from growing by one directory per run forever.
        await requestQueue.drop().catch(() => {});
    }
}
