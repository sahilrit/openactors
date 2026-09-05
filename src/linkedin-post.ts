/**
 * Reads a public LinkedIn post page.
 *
 * LinkedIn serves a logged-out view of a public post that embeds a schema.org
 * `SocialMediaPosting` block, and that block carries the body, the author, the
 * reaction and comment counts, and whatever slice of the comment thread the
 * logged-out view is willing to show. No account, cookie or session is
 * involved, which is the whole reason these two Actors exist and the engager
 * and profile-comment ones do not: those have no logged-out equivalent.
 *
 * What the logged-out view will not give you:
 *  - comment URNs, so a reply cannot be addressed from this data
 *  - comment author profile URLs, only display names
 *  - nested replies
 *  - the full thread on a heavily-commented post
 */

const UA =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

export interface ParsedComment {
    text: string | null;
    authorName: string | null;
    createdAt: string | null;
    likes: number | null;
}

export interface ParsedPost {
    text: string | null;
    headline: string | null;
    url: string;
    activityId: string | null;
    createdAt: string | null;
    authorName: string | null;
    authorProfileUrl: string | null;
    totalReactions: number | null;
    commentCount: number | null;
    images: string[];
    comments: ParsedComment[];
}

/**
 * Accepts a full post URL, a bare activity id, or a `urn:li:activity:*` urn and
 * returns a URL that renders logged out.
 *
 * `/feed/update/urn:li:activity:<id>/` is the form that works from an id alone;
 * `/posts/activity-<id>` 404s, so an id is never turned into a `/posts/` URL.
 */
export function resolvePostUrl(input: string): string {
    const raw = String(input ?? '').trim();
    if (!raw) throw new Error('a post URL, activity id, or urn is required');
    if (/^https?:\/\//i.test(raw)) return raw;

    const id = raw.match(/(?:urn:li:(?:activity|ugcPost|share):)?(\d{10,})/)?.[1];
    if (!id) throw new Error(`could not find an activity id in "${raw}"`);
    return `https://www.linkedin.com/feed/update/urn:li:activity:${id}/`;
}

/** Pulls the numeric activity id out of a URL or urn, if one is present. */
export function activityIdFrom(value: string | null | undefined): string | null {
    if (!value) return null;
    return value.match(/(?:activity[:-]|urn:li:activity:)(\d{10,})/)?.[1] ?? null;
}

function decodeEntities(s: string): string {
    return s
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&apos;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&');
}

function counterFor(stats: unknown, action: string): number | null {
    const list = Array.isArray(stats) ? stats : stats ? [stats] : [];
    for (const entry of list as Record<string, unknown>[]) {
        const type = String(entry?.interactionType ?? '');
        if (type.toLowerCase().endsWith(action.toLowerCase())) {
            const n = Number(entry?.userInteractionCount);
            if (Number.isFinite(n)) return n;
        }
    }
    return null;
}

/** Extracts the post from a fetched page. Throws if the page carries no post. */
export function parsePostPage(html: string, sourceUrl: string): ParsedPost {
    const block = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)?.[1];
    if (!block) {
        throw new Error('no schema.org block on the page (post is private, removed, or login-walled)');
    }

    let data: Record<string, any>;
    try {
        data = JSON.parse(block);
    } catch {
        throw new Error('schema.org block on the page was not valid JSON');
    }

    // og:description is the fallback when articleBody is absent; it is truncated,
    // so it is only used when there is nothing better.
    const og = html.match(/<meta property="og:description" content="([\s\S]*?)"\s*\/?>/)?.[1];
    const text = data.articleBody ?? (og ? decodeEntities(og) : null);

    const author = (data.author ?? {}) as Record<string, any>;
    const comments: ParsedComment[] = (Array.isArray(data.comment) ? data.comment : []).map(
        (c: Record<string, any>) => ({
            text: c?.text ?? null,
            authorName: c?.author?.name ?? null,
            createdAt: c?.datePublished ?? null,
            likes: counterFor(c?.interactionStatistic, 'LikeAction'),
        }),
    );

    const canonical = typeof data['@id'] === 'string' ? data['@id'] : sourceUrl;

    return {
        text: text ?? null,
        headline: data.headline ?? null,
        url: canonical,
        activityId: activityIdFrom(canonical) ?? activityIdFrom(sourceUrl),
        createdAt: data.datePublished ?? null,
        authorName: author.name ?? null,
        authorProfileUrl: author.url ?? null,
        totalReactions: counterFor(data.interactionStatistic, 'LikeAction'),
        commentCount:
            typeof data.commentCount === 'number'
                ? data.commentCount
                : counterFor(data.interactionStatistic, 'CommentAction'),
        images: (Array.isArray(data.image) ? data.image : [])
            .map((i: Record<string, any>) => i?.url)
            .filter((u: unknown): u is string => typeof u === 'string'),
        comments,
    };
}

export const POST_PAGE_HEADERS = { 'user-agent': UA, accept: 'text/html' };
