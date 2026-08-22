/**
 * Maps well-known Apify Actor ids onto local equivalents, so a client already
 * configured against mcp.apify.com keeps working after changing only the URL.
 *
 * This is a compatibility shim, not parity. Apify has tens of thousands of
 * Actors; we alias the handful we actually reimplement, and `resolveActorName`
 * leaves anything else untouched so the caller gets a clear "not found" naming
 * the id they asked for.
 */
export const ACTOR_ALIASES: Record<string, string> = {
    'apify/website-content-crawler': 'web/site-crawler',
    'apify~website-content-crawler': 'web/site-crawler',
};

export function resolveActorName(requested: string): string {
    return ACTOR_ALIASES[requested] ?? requested.replace(/~/g, '/');
}
