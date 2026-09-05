import { RateLimiter, fetchText } from '../../../src/fetcher.js';
import { POST_PAGE_HEADERS, parsePostPage, resolvePostUrl } from '../../../src/linkedin-post.js';
import type { ActorContext } from '../../../src/types.js';

interface Input {
    postIds?: string[];
    post_urls?: string[];
    maxItems?: number;
    scrapeReplies?: boolean;
}

const limiter = new RateLimiter(3000);

export async function run(input: Input, ctx: ActorContext): Promise<void> {
    const targets = input.postIds ?? input.post_urls ?? [];
    if (!Array.isArray(targets) || targets.length === 0) {
        throw new Error('postIds is required, e.g. ["7236288582401884162"]');
    }

    const max = input.maxItems ?? 20;
    let total = 0;
    let truncated = false;

    for (const raw of targets) {
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

        // A post can report 40 comments and show 3 logged out. Saying so beats
        // letting a caller read the short list as the whole thread.
        if ((post.commentCount ?? 0) > post.comments.length) truncated = true;
        ctx.log(
            `${post.activityId ?? url}: ${post.comments.length} comment(s) visible of ${post.commentCount ?? '?'} reported`,
        );

        for (const c of post.comments.slice(0, max)) {
            await ctx.pushData({
                post_id: post.activityId,
                post_url: post.url,
                comment_id: null,
                comment_urn: null,
                text: c.text,
                created_at: c.createdAt,
                likes: c.likes,
                author: { name: c.authorName, profile_url: null, headline: null },
                replies: [],
            });
            total += 1;
        }
    }

    // The client drops any item carrying a "summary" key, so this is metadata
    // for a human reading the dataset, not a record the skills will see.
    await ctx.pushData({
        summary: {
            posts_requested: targets.length,
            comments_returned: total,
            thread_truncated: truncated,
            replies_available: false,
            note: 'Logged-out view: no comment URNs, no nested replies. Read-only.',
        },
    });
    ctx.log(`finished: ${total} comment(s) across ${targets.length} post(s)`);
}
