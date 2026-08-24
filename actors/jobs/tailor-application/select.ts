/**
 * Chooses which of a candidate's achievements to lead with for a given posting.
 *
 * Tailoring here means reordering and emphasis, never invention: the selector
 * can only rank bullets it was handed, and every bullet traces to the approved
 * numbers ledger. A generator that could write new claims would, across a
 * hundred applications, eventually write one that cannot be defended.
 */

export interface Bullet {
    role: string;
    tags: string[];
    text: string;
}

/**
 * Phrases a posting uses, mapped to the tags the profile uses. Postings say
 * "conversion rate optimisation"; the profile says "cro".
 */
const SIGNALS: Record<string, RegExp> = {
    meta: /\b(?:meta ads?|facebook ads?|fb ads?|instagram ads?|paid social)\b/i,
    google: /\b(?:google ads?|adwords|paid search|ppc|sem|performance max|pmax)\b/i,
    shopify: /\bshopify\b/i,
    ecommerce: /\b(?:e-?commerce|d2c|dtc|direct[- ]to[- ]consumer|online store)\b/i,
    'media-buying': /\b(?:media buy(?:er|ing)|buying media|campaign management)\b/i,
    spend: /\b(?:ad spend|budget|six[- ]figure|monthly spend|p&l)\b/i,
    roas: /\b(?:roas|return on ad spend|blended return)\b/i,
    cro: /\b(?:conversion rate optimi[sz]ation|\bcro\b|landing page optimi[sz]ation|a\/b test)\b/i,
    'landing-page': /\b(?:landing pages?|funnel pages?)\b/i,
    funnel: /\b(?:full[- ]funnel|funnel strateg|acquisition funnel)\b/i,
    creative: /\b(?:creative (?:testing|strategy|production)|ad copy|copywriting|ugc)\b/i,
    testing: /\b(?:a\/b testing|experimentation|test(?:ing)? framework|incrementality)\b/i,
    analytics: /\b(?:google analytics|ga4|attribution|dashboard|reporting|data[- ]driven)\b/i,
    leadership: /\b(?:lead(?:ing)? a team|manage(?:s|d)? people|line manage|mentor|hiring|team of)\b/i,
    'lead-gen': /\b(?:lead gen(?:eration)?|demand gen(?:eration)?|\bcpl\b|mql)\b/i,
    growth: /\b(?:growth marketing|user acquisition|scal(?:e|ing) (?:spend|acquisition))\b/i,
    influencer: /\b(?:influencer|creator marketing|affiliate)\b/i,
    strategy: /\b(?:strateg(?:y|ic)|roadmap|go[- ]to[- ]market)\b/i,
};

export function extractSignals(text: string): string[] {
    const haystack = text ?? '';
    return Object.entries(SIGNALS)
        .filter(([, pattern]) => pattern.test(haystack))
        .map(([tag]) => tag);
}

/**
 * Reorders bullets by how many of the posting's signals they answer.
 *
 * Nothing is dropped. A candidate's strongest achievement is still their
 * strongest achievement even when the posting never mentions it, and a resume
 * pruned to only what was asked for reads thinner than the person is.
 */
export function scoreBullets(bullets: Bullet[], signals: string[]): Bullet[] {
    if (signals.length === 0) return [...bullets];
    const wanted = new Set(signals);

    return [...bullets]
        .map((bullet, index) => ({
            bullet,
            index,
            score: bullet.tags.filter((t) => wanted.has(t)).length,
        }))
        // Original order breaks ties, so equally relevant bullets keep the
        // deliberate ordering of the profile rather than being shuffled.
        .sort((a, b) => b.score - a.score || a.index - b.index)
        .map((entry) => entry.bullet);
}
