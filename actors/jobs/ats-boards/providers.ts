/**
 * Adapters for the public job-board APIs that applicant tracking systems expose
 * so customers can embed listings on their own marketing sites. They need no
 * authentication and no scraping — this Actor is plain HTTP against documented
 * JSON, which is why it is both free and unblockable.
 *
 * Every ATS returns a different shape, so each adapter's only job is to map its
 * provider onto `NormalizedJob`. Adapters are pure functions over parsed JSON,
 * which is what makes them unit-testable against recorded fixtures — and they
 * are the part most likely to break silently when a provider changes a field.
 */

export interface NormalizedJob {
    ats: string;
    account: string;
    id: string;
    title: string;
    url: string;
    applyUrl: string | null;
    location: string | null;
    /** True/false where the provider states it; null where it must be guessed. */
    remote: boolean | null;
    department: string | null;
    team: string | null;
    employmentType: string | null;
    publishedAt: string | null;
    description: string | null;
}

export interface Provider {
    /** Builds the public endpoint for one account/board. */
    url(account: string, withDescription: boolean): string;
    /** Pulls the job array out of the provider's envelope. */
    extract(body: any): any[];
    normalize(raw: any, account: string): NormalizedJob;
    /** False where we could not find a populated live board to test against. */
    verified: boolean;
}

const str = (v: unknown): string | null => {
    if (v === null || v === undefined) return null;
    const s = String(v).trim();
    return s.length > 0 ? s : null;
};

/** Only used where the provider gives no explicit remote flag. */
const looksRemote = (location: string | null): boolean | null =>
    location === null ? null : /\bremote\b|\banywhere\b|work from home/i.test(location);

const iso = (v: unknown): string | null => {
    if (v === null || v === undefined) return null;
    // Lever reports epoch milliseconds; the rest use ISO strings.
    const d = typeof v === 'number' ? new Date(v) : new Date(String(v));
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

export const PROVIDERS: Record<string, Provider> = {
    greenhouse: {
        verified: true,
        // Greenhouse returns `departments` only under `?content=true`, the same
        // flag that pulls in full descriptions — so `department` is populated
        // only when the caller asks for descriptions. Always requesting it
        // would multiply the response size of a large board several times over
        // for a field most searches never read.
        url: (a, d) => `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(a)}/jobs${d ? '?content=true' : ''}`,
        extract: (b) => b?.jobs ?? [],
        normalize: (j, account) => {
            const location = str(j.location?.name);
            return {
                ats: 'greenhouse',
                account,
                id: String(j.id),
                title: str(j.title) ?? '(untitled)',
                url: str(j.absolute_url) ?? '',
                applyUrl: str(j.absolute_url),
                location,
                remote: looksRemote(location),
                department: str(j.departments?.[0]?.name),
                team: null,
                employmentType: null,
                publishedAt: iso(j.first_published ?? j.updated_at),
                description: str(j.content),
            };
        },
    },

    lever: {
        verified: true,
        url: (a) => `https://api.lever.co/v0/postings/${encodeURIComponent(a)}?mode=json`,
        extract: (b) => (Array.isArray(b) ? b : []),
        normalize: (j, account) => {
            const location = str(j.categories?.location);
            return {
                ats: 'lever',
                account,
                id: String(j.id),
                title: str(j.text) ?? '(untitled)',
                url: str(j.hostedUrl) ?? '',
                applyUrl: str(j.applyUrl),
                location,
                // Lever states workplaceType directly on newer postings.
                remote: j.workplaceType ? /remote/i.test(String(j.workplaceType)) : looksRemote(location),
                department: str(j.categories?.department),
                team: str(j.categories?.team),
                employmentType: str(j.categories?.commitment),
                publishedAt: iso(j.createdAt),
                description: str(j.descriptionPlain ?? j.description),
            };
        },
    },

    ashby: {
        verified: true,
        url: (a) => `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(a)}`,
        extract: (b) => b?.jobs ?? [],
        normalize: (j, account) => ({
            ats: 'ashby',
            account,
            id: String(j.id),
            title: str(j.title) ?? '(untitled)',
            url: str(j.jobUrl) ?? '',
            applyUrl: str(j.applyUrl),
            location: str(j.location),
            remote: typeof j.isRemote === 'boolean' ? j.isRemote : looksRemote(str(j.location)),
            department: str(j.department),
            team: str(j.team),
            employmentType: str(j.employmentType),
            publishedAt: iso(j.publishedAt),
            description: str(j.descriptionPlain ?? j.descriptionHtml),
        }),
    },

    smartrecruiters: {
        verified: true,
        url: (a) => `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(a)}/postings?limit=100`,
        extract: (b) => b?.content ?? [],
        normalize: (j, account) => {
            const location = str(j.location?.fullLocation ?? [j.location?.city, j.location?.country].filter(Boolean).join(', '));
            return {
                ats: 'smartrecruiters',
                account,
                id: String(j.id),
                title: str(j.name) ?? '(untitled)',
                url: `https://jobs.smartrecruiters.com/${account}/${j.id}`,
                applyUrl: `https://jobs.smartrecruiters.com/${account}/${j.id}`,
                location,
                remote: typeof j.location?.remote === 'boolean' ? j.location.remote : looksRemote(location),
                department: str(j.department?.label),
                team: str(j.function?.label),
                employmentType: str(j.typeOfEmployment?.label),
                publishedAt: iso(j.releasedDate),
                description: null,
            };
        },
    },

    // The endpoint and envelope below are confirmed live; the per-job fields are
    // taken from provider documentation because every Workable board reachable
    // during development had zero open roles. Normalization is written
    // defensively so an unexpected shape yields a thin record, not a crash.
    workable: {
        verified: false,
        url: (a, d) => `https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(a)}?details=${d}`,
        extract: (b) => b?.jobs ?? [],
        normalize: (j, account) => {
            const location = str(j.location?.location_str ?? [j.city, j.country].filter(Boolean).join(', '));
            return {
                ats: 'workable',
                account,
                id: String(j.id ?? j.shortcode ?? ''),
                title: str(j.title) ?? '(untitled)',
                url: str(j.url ?? j.application_url) ?? '',
                applyUrl: str(j.application_url ?? j.url),
                location,
                remote: typeof j.telecommuting === 'boolean' ? j.telecommuting : looksRemote(location),
                department: str(j.department),
                team: null,
                employmentType: str(j.employment_type),
                publishedAt: iso(j.published_on ?? j.created_at),
                description: str(j.description),
            };
        },
    },

    // Same caveat as Workable: no populated live board was available to verify
    // the per-job fields against.
    recruitee: {
        verified: false,
        url: (a) => `https://${encodeURIComponent(a)}.recruitee.com/api/offers/`,
        extract: (b) => b?.offers ?? [],
        normalize: (j, account) => {
            const location = str(j.location ?? [j.city, j.country].filter(Boolean).join(', '));
            return {
                ats: 'recruitee',
                account,
                id: String(j.id),
                title: str(j.title) ?? '(untitled)',
                url: str(j.careers_url ?? j.url) ?? '',
                applyUrl: str(j.careers_apply_url ?? j.careers_url),
                location,
                remote: typeof j.remote === 'boolean' ? j.remote : looksRemote(location),
                department: str(j.department),
                team: null,
                employmentType: str(j.employment_type_code ?? j.employment_type),
                publishedAt: iso(j.published_at),
                description: str(j.description),
            };
        },
    },
};

export const PROVIDER_NAMES = Object.keys(PROVIDERS);
