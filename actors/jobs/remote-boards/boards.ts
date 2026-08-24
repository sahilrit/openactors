/**
 * Job boards that list only remote work.
 *
 * These matter because a country search on a general board returns roles that
 * are remote *within* that country — remote from Austin, still requiring US
 * work authorisation. Boards built for remote work carry an explicit
 * restriction field instead, which is the difference between "remote" and
 * "remote and open to you".
 *
 * All three serve public JSON with no key. RemoteOK's terms ask for a link
 * back if you republish their listings.
 */

export interface RemoteJob {
    board: string;
    title: string | null;
    company: string | null;
    url: string;
    /** Where the candidate may be. "Worldwide" when the board states none. */
    restriction: string | null;
    category: string | null;
    tags: string[];
    salary: string | null;
    postedAt: string | null;
    /** Set only when the caller passes `eligibleFrom`. */
    eligibility?: 'open' | 'restricted' | 'unknown';
    eligibilityReason?: string;
}

export interface Board {
    url(cursor?: string): string;
    extract(body: any): any[];
    normalize(raw: any): RemoteJob;
    /**
     * Cursor for the next page, when the board pages. Returning null ends the
     * walk — a board that always returns a cursor would otherwise loop forever.
     */
    nextCursor?(body: any, received: number): string | null;
}

const str = (v: unknown): string | null => {
    if (v === null || v === undefined) return null;
    const s = String(v).trim();
    return s.length > 0 ? s : null;
};

const iso = (v: unknown): string | null => {
    if (v === null || v === undefined || v === '') return null;
    // Himalayas sends seconds since the epoch; the others send ISO strings.
    const date = typeof v === 'number' ? new Date(v * 1000) : new Date(String(v));
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

export const BOARDS: Record<string, Board> = {
    remoteok: {
        url: () => 'https://remoteok.com/api',
        // The first element is a legal notice rather than a job.
        extract: (b) => (Array.isArray(b) ? b.filter((x) => x && (x.position || x.slug)) : []),
        normalize: (j) => ({
            board: 'remoteok',
            title: str(j.position),
            company: str(j.company),
            url: str(j.url ?? j.apply_url) ?? '',
            restriction: str(j.location) ?? 'Worldwide',
            category: str(Array.isArray(j.tags) ? j.tags[0] : null),
            tags: Array.isArray(j.tags) ? j.tags.map(String) : [],
            salary: j.salary_min ? `${j.salary_min}-${j.salary_max ?? ''}` : null,
            postedAt: iso(j.date),
        }),
    },

    remotive: {
        url: () => 'https://remotive.com/api/remote-jobs',
        extract: (b) => b?.jobs ?? [],
        normalize: (j) => ({
            board: 'remotive',
            title: str(j.title),
            company: str(j.company_name),
            url: str(j.url) ?? '',
            restriction: str(j.candidate_required_location) ?? 'Worldwide',
            category: str(j.category),
            tags: Array.isArray(j.tags) ? j.tags.map(String) : [],
            salary: str(j.salary),
            postedAt: iso(j.publication_date),
        }),
    },

    himalayas: {
        url: (cursor) =>
            `https://himalayas.app/jobs/api?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
        extract: (b) => b?.jobs ?? b?.data ?? [],
        // The feed runs to thousands of roles and serves twenty at a time, so
        // without paging this board contributes almost nothing.
        nextCursor: (b, received) => (received > 0 && b?.nextCursor ? String(b.nextCursor) : null),
        normalize: (j) => {
            const restrictions = Array.isArray(j.locationRestrictions) ? j.locationRestrictions.filter(Boolean) : [];
            return {
                board: 'himalayas',
                title: str(j.title),
                company: str(j.companyName),
                url: str(j.applicationLink) ?? (j.companySlug ? `https://himalayas.app/companies/${j.companySlug}` : ''),
                // An empty restriction list is the board stating "anywhere",
                // not missing data — this field is the reason it exists.
                restriction: restrictions.length > 0 ? restrictions.join(', ') : 'Worldwide',
                category: str(Array.isArray(j.categories) ? j.categories[0] : null),
                tags: Array.isArray(j.categories) ? j.categories.map(String) : [],
                salary: j.minSalary ? `${j.minSalary}-${j.maxSalary ?? ''} ${j.currency ?? ''}`.trim() : null,
                postedAt: iso(j.pubDate),
            };
        },
    },
};

export const BOARD_NAMES = Object.keys(BOARDS);
