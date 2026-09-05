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
    'apify/rag-web-browser': 'web/rag-browser',
    'compass/crawler-google-places': 'maps/google-maps',
    'compass/google-maps-scraper': 'maps/google-maps',
    'nwua9Gu5YrADL7ZDj/google-maps-scraper': 'maps/google-maps',
};

export function resolveActorName(requested: string): string {
    // Apify ids travel in both `owner/name` and `owner~name` form, and clients
    // built against its REST API send the tilde. Normalise first, then look the
    // alias up, or a tilde id would miss the table and resolve to a local name
    // that does not exist.
    const normalized = requested.replace(/~/g, '/');
    return ACTOR_ALIASES[normalized] ?? normalized;
}
