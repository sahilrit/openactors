import { RateLimiter, fetchText } from '../../../src/fetcher.js';
import { POST_PAGE_HEADERS, parsePostPage, resolvePostUrl } from '../../../src/linkedin-post.js';
import type { ActorContext } from '../../../src/types.js';

interface Input {
    post_urls?: string[];
    postUrls?: string[];
    urls?: string[];
    maxItems?: number;
}

/** Same three seconds the jobs Actor uses. LinkedIn answers a fast run with 429s. */
const limiter = new RateLimiter(3000);

export async function run(input: Input, ctx: ActorContext): Promise<void> {
    const urls = input.post_urls ?? input.postUrls ?? input.urls ?? [];
    if (!Array.isArray(urls) || urls.length === 0) {
        throw new Error('post_urls is required, e.g. ["https://www.linkedin.com/posts/...-activity-123..."]');
    }

    const max = input.maxItems ?? 25;
    let done = 0;

    for (const raw of urls.slice(0, max)) {
        if (ctx.signal.aborted) break;
        let url: string;
        try {
            url = resolvePostUrl(raw);
        } catch (err) {
            ctx.log(`skipping "${raw}": ${(err as Error).message}`);
            continue;
        }

        await limiter.take('linkedin.com');
        const { status, body } = await fetchText(url, {
            signal: ctx.signal,
            headers: POST_PAGE_HEADERS,
            session: 'linkedin',
        });
        if (status !== 200) {
            ctx.log(`skipping ${url}: HTTP ${status}`);
            continue;
        }

        let post;
        try {
            post = parsePostPage(body, url);
        } catch (err) {
            ctx.log(`skipping ${url}: ${(err as Error).message}`);
            continue;
        }

        // Nested shape, matching what linkedin-skills' apify_client normalizes.
        // Fields the logged-out page cannot supply stay null rather than being
        // guessed at, so a caller can tell "absent" from "zero".
        await ctx.pushData({
            post: {
                text: post.text,
                url: post.url,
                type: 'post',
                created_at: post.createdAt,
                urn: { activity_urn: post.activityId, share_urn: null, ugcPost_urn: null },
            },
            author: {
                name: post.authorName,
                headline: null,
                profile_url: post.authorProfileUrl,
                followers: null,
            },
            stats: {
                total_reactions: post.totalReactions,
                comments: post.commentCount,
                shares: null,
                reactions: null,
            },
            is_reshared: null,
            reshared_post: null,
            headline: post.headline,
            images: post.images,
        });
        done += 1;
    }

    ctx.log(`finished: ${done} post(s) of ${urls.length} requested`);
}
