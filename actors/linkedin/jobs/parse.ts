import { JSDOM, VirtualConsole } from 'jsdom';

/**
 * Parses LinkedIn's public guest job-search markup.
 *
 * This is the endpoint LinkedIn's own logged-out job search calls, returning a
 * fragment of `<div class="base-card">` elements. No account is involved, so
 * unlike cookie-based scraping there is nothing here that can be restricted.
 *
 * Fields are read from `data-entity-urn` and the semantic tags (`h3`, `h4`,
 * `time[datetime]`) rather than the utility classes beside them: the markup
 * carries Tailwind-style classes such as `relative w-full hover:no-underline`
 * that change with styling work, while the structure does not.
 */

export interface LinkedInJob {
    id: string | null;
    title: string | null;
    company: string | null;
    companyUrl: string | null;
    location: string | null;
    postedAt: string | null;
    url: string;
}

const clean = (value: string | null | undefined): string | null => {
    if (value === null || value === undefined) return null;
    const text = value.replace(/\s+/g, ' ').trim();
    return text.length > 0 ? text : null;
};

export function parseCards(html: string): LinkedInJob[] {
    const doc = new JSDOM(html, { virtualConsole: new VirtualConsole() }).window.document;
    const jobs: LinkedInJob[] = [];

    for (const card of doc.querySelectorAll('div.base-card')) {
        const link = card.querySelector('a.base-card__full-link') ?? card.querySelector('a[href*="/jobs/view/"]');
        // Tracking parameters make otherwise identical postings look distinct,
        // which would defeat deduplication across pages.
        const url = link?.getAttribute('href')?.split('?')[0] ?? null;
        if (!url) continue;

        // "urn:li:jobPosting:4443392386" — the stable posting id.
        const urn = card.getAttribute('data-entity-urn') ?? '';
        const idFromUrn = urn.split(':').pop();
        // Fall back to the numeric id trailing the slug in the URL.
        const idFromUrl = url.match(/-(\d+)$/)?.[1] ?? null;

        const companyLink = card.querySelector('h4 a');

        jobs.push({
            id: idFromUrn && /^\d+$/.test(idFromUrn) ? idFromUrn : idFromUrl,
            title: clean(card.querySelector('h3')?.textContent),
            company: clean(companyLink?.textContent ?? card.querySelector('h4')?.textContent),
            companyUrl: companyLink?.getAttribute('href')?.split('?')[0] ?? null,
            location: clean(card.querySelector('.job-search-card__location')?.textContent),
            // LinkedIn stamps a plain date ("2026-08-11"); normalize to ISO.
            postedAt: toIso(card.querySelector('time')?.getAttribute('datetime')),
            url,
        });
    }

    return jobs;
}

function toIso(value: string | null | undefined): string | null {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
