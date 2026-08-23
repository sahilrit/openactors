/**
 * Works out whether a job posting is actually open to someone in a given
 * country.
 *
 * "Remote" is not a location. A posting reading "Remote U.S." or "North
 * America" is remote and still closed to a candidate in India, so a boolean
 * `remote` flag tells a job seeker without work authorisation almost nothing.
 *
 * The answer is deliberately three-valued rather than a boolean, for the same
 * reason `workplaceType` beat `isRemote`: a great many postings say only
 * "Remote" with no geography at all, and those are genuinely unknown — the
 * restriction, if any, is buried in the description. Collapsing unknown into
 * either yes or no would silently either hide real opportunities or promise
 * ones that do not exist.
 */

export type Eligibility = 'open' | 'restricted' | 'unknown';

export interface EligibilityVerdict {
    eligibility: Eligibility;
    /** Short human-readable explanation, surfaced on each result row. */
    reason: string;
    /** ISO-3166 alpha-2 codes the posting appears to name. */
    territories: string[];
}

/** Regions as they are actually written on job boards, mapped to member countries. */
const REGIONS: Record<string, string[]> = {
    'north america': ['US', 'CA', 'MX'],
    americas: ['US', 'CA', 'MX', 'BR', 'AR', 'CO', 'CL', 'PE'],
    'latin america': ['BR', 'AR', 'CO', 'CL', 'PE', 'MX', 'UY'],
    latam: ['BR', 'AR', 'CO', 'CL', 'PE', 'MX', 'UY'],
    europe: ['GB', 'IE', 'DE', 'FR', 'ES', 'PT', 'IT', 'NL', 'BE', 'AT', 'CH', 'SE', 'NO', 'DK', 'FI', 'PL', 'CZ', 'RO', 'GR', 'HU'],
    'european union': ['DE', 'FR', 'ES', 'PT', 'IT', 'NL', 'BE', 'AT', 'SE', 'DK', 'FI', 'PL', 'CZ', 'RO', 'GR', 'HU', 'IE'],
    eea: ['DE', 'FR', 'ES', 'PT', 'IT', 'NL', 'BE', 'AT', 'SE', 'DK', 'FI', 'PL', 'CZ', 'RO', 'GR', 'HU', 'IE', 'NO', 'IS'],
    emea: ['GB', 'IE', 'DE', 'FR', 'ES', 'PT', 'IT', 'NL', 'BE', 'AT', 'CH', 'SE', 'NO', 'DK', 'FI', 'PL', 'AE', 'SA', 'IL', 'ZA', 'EG', 'NG', 'KE'],
    mena: ['AE', 'SA', 'IL', 'EG', 'MA', 'QA', 'KW', 'JO'],
    nordics: ['SE', 'NO', 'DK', 'FI', 'IS'],
    dach: ['DE', 'AT', 'CH'],
    benelux: ['NL', 'BE', 'LU'],
    'uk&i': ['GB', 'IE'],
    apac: ['IN', 'SG', 'AU', 'NZ', 'JP', 'HK', 'MY', 'PH', 'ID', 'TH', 'VN', 'KR', 'CN', 'TW'],
    'asia pacific': ['IN', 'SG', 'AU', 'NZ', 'JP', 'HK', 'MY', 'PH', 'ID', 'TH', 'VN', 'KR', 'CN', 'TW'],
    'asia-pacific': ['IN', 'SG', 'AU', 'NZ', 'JP', 'HK', 'MY', 'PH', 'ID', 'TH', 'VN', 'KR', 'CN', 'TW'],
    asia: ['IN', 'SG', 'JP', 'HK', 'MY', 'PH', 'ID', 'TH', 'VN', 'KR', 'CN', 'TW'],
    sea: ['SG', 'MY', 'PH', 'ID', 'TH', 'VN'],
    anz: ['AU', 'NZ'],
};

/** Country spellings seen on real boards. Longest match wins, so order is irrelevant. */
const COUNTRIES: Record<string, string> = {
    'united states': 'US', 'united states of america': 'US', 'u.s.a': 'US', 'u.s.': 'US', usa: 'US', us: 'US',
    'united kingdom': 'GB', 'great britain': 'GB', england: 'GB', scotland: 'GB', wales: 'GB', uk: 'GB',
    canada: 'CA', mexico: 'MX', brazil: 'BR', argentina: 'AR', colombia: 'CO', chile: 'CL', peru: 'PE',
    ireland: 'IE', germany: 'DE', deutschland: 'DE', france: 'FR', spain: 'ES', portugal: 'PT', italy: 'IT',
    netherlands: 'NL', belgium: 'BE', austria: 'AT', switzerland: 'CH', sweden: 'SE', norway: 'NO',
    denmark: 'DK', finland: 'FI', poland: 'PL', czechia: 'CZ', 'czech republic': 'CZ', romania: 'RO',
    greece: 'GR', hungary: 'HU', iceland: 'IS', luxembourg: 'LU',
    india: 'IN', singapore: 'SG', australia: 'AU', 'new zealand': 'NZ', japan: 'JP', 'hong kong': 'HK',
    malaysia: 'MY', philippines: 'PH', indonesia: 'ID', thailand: 'TH', vietnam: 'VN', 'south korea': 'KR',
    china: 'CN', taiwan: 'TW', 'united arab emirates': 'AE', uae: 'AE', 'saudi arabia': 'SA', israel: 'IL',
    'south africa': 'ZA', egypt: 'EG', nigeria: 'NG', kenya: 'KE', morocco: 'MA', qatar: 'QA',
};

/** US state codes, which is how American cities are written ("Foster City, CA"). */
const US_STATES = new Set([
    'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD',
    'MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC',
    'SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','DC',
]);

/** Phrases that mean genuinely no geographic restriction. */
const WORLDWIDE = /\b(worldwide|world ?wide|anywhere|global|globally|any location|location independent|fully distributed)\b/i;

function findTerritories(text: string): string[] {
    const lower = ` ${text.toLowerCase()} `;
    const found = new Set<string>();

    for (const [region, members] of Object.entries(REGIONS)) {
        if (lower.includes(` ${region} `) || lower.includes(`${region},`) || lower.includes(`(${region}`)) {
            for (const code of members) found.add(code);
        }
    }

    // Word-boundary matched so "us" does not fire inside "Austin" or "campus".
    for (const [name, code] of Object.entries(COUNTRIES)) {
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (new RegExp(`(^|[^a-z])${escaped}([^a-z]|$)`, 'i').test(lower)) found.add(code);
    }

    // A US state code counts only as a standalone two-letter token inside a
    // comma-separated part, so "IN" as Indiana is never confused with a word
    // inside a phrase. The part is not required to be *only* the state code —
    // boards write "New York, NY (HQ)" and the suffix must not hide it.
    for (const part of text.split(/[,;/|]/)) {
        for (const token of part.trim().toUpperCase().split(/[^A-Z]+/)) {
            if (token.length === 2 && US_STATES.has(token)) found.add('US');
        }
    }

    return [...found];
}

/**
 * Classifies a posting's location for a candidate in `countryCode`.
 *
 * `workplaceType` is consulted because an on-site role is closed regardless of
 * what its location says — a candidate who cannot relocate cannot take it.
 */
export function classifyEligibility(
    location: string | null,
    countryCode: string,
    workplaceType?: string | null,
): EligibilityVerdict {
    const country = countryCode.trim().toUpperCase();
    const text = (location ?? '').trim();

    if (workplaceType && /^(onsite|on-site|on site)$/i.test(workplaceType.trim())) {
        const territories = findTerritories(text);
        return territories.includes(country)
            ? { eligibility: 'open', reason: `on-site in ${country}`, territories }
            : { eligibility: 'restricted', reason: 'on-site role', territories };
    }

    if (text === '') return { eligibility: 'unknown', reason: 'no location given', territories: [] };

    if (WORLDWIDE.test(text)) {
        return { eligibility: 'open', reason: 'stated as worldwide', territories: [] };
    }

    const territories = findTerritories(text);

    if (territories.includes(country)) {
        return { eligibility: 'open', reason: `names ${country}`, territories };
    }

    if (territories.length > 0) {
        return {
            eligibility: 'restricted',
            reason: `limited to ${territories.slice(0, 4).join(', ')}${territories.length > 4 ? '…' : ''}`,
            territories,
        };
    }

    // "Remote" / "Remote job" with no geography: the common case, and genuinely
    // ambiguous. Any restriction lives in the description, which is not read here.
    if (/\bremote\b/i.test(text)) {
        return { eligibility: 'unknown', reason: 'remote with no region stated', territories: [] };
    }

    return { eligibility: 'unknown', reason: 'location not recognised', territories: [] };
}
