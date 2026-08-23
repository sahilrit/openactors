import { CheerioCrawler } from '@crawlee/cheerio';
import { RequestQueue } from '@crawlee/core';
import { htmlToMarkdown } from '../../../src/extract.js';
import type { ActorContext } from '../../../src/types.js';

interface Input {
    startUrls: string[];
    maxPages?: number;
    maxDepth?: number;
    sameDomainOnly?: boolean;
    includeUrlPattern?: string;
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
        // Crawlee's session pool rotates identities and retires a session that
        // starts getting blocked, instead of hammering a target with one that
        // has already been flagged.
        useSessionPool: true,
        persistCookiesPerSession: true,
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
