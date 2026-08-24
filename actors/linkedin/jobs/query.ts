/**
 * Builds LinkedIn's public job-search URL.
 *
 * Separated from the Actor so the query construction can be tested directly:
 * a wrong filter code does not error, it silently returns nothing, which looks
 * exactly like a job market with nothing in it.
 */

export interface SearchInput {
    keywords: string;
    location?: string;
    remoteOnly?: boolean;
    postedWithinDays?: number;
    jobTypes?: JobType[];
}

export type JobType = 'full-time' | 'contract' | 'freelance' | 'part-time' | 'temporary' | 'internship';

/**
 * The codes LinkedIn's own filter UI sets. Freelance work is posted as
 * contract or temporary — there is no separate freelance code — so `freelance`
 * maps onto contract rather than being rejected as unknown.
 */
export const JOB_TYPE_CODES: Record<JobType, string> = {
    'full-time': 'F',
    contract: 'C',
    freelance: 'C',
    'part-time': 'P',
    temporary: 'T',
    internship: 'I',
};

const ENDPOINT = 'https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search';

export function buildSearchUrl(input: SearchInput, start: number): string {
    const params = new URLSearchParams({
        keywords: input.keywords,
        location: input.location ?? 'Worldwide',
        start: String(start),
    });

    if (input.postedWithinDays) params.set('f_TPR', `r${input.postedWithinDays * 86_400}`);
    if (input.remoteOnly) params.set('f_WT', '2');

    if (input.jobTypes?.length) {
        // Unknown values are dropped rather than passed through: LinkedIn
        // answers a bad code with an empty result set, not an error.
        const codes = [...new Set(input.jobTypes.map((t) => JOB_TYPE_CODES[t]).filter(Boolean))];
        // Repeated rather than comma-joined. URLSearchParams percent-encodes a
        // comma, and LinkedIn ignores the encoded form entirely — returning
        // unfiltered results that are indistinguishable from a working filter.
        for (const code of codes) params.append('f_JT', code);
    }

    return `${ENDPOINT}?${params.toString()}`;
}
