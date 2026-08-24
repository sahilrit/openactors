import { JSDOM, VirtualConsole } from 'jsdom';
import { RateLimiter, fetchText } from '../../../src/fetcher.js';
import type { ActorContext } from '../../../src/types.js';
import { classifyWorkplace, type WorkplaceVerdict } from './classify.js';

interface Input {
    urls: string[];
    keepVerdicts?: WorkplaceVerdict[];
    maxConcurrent?: number;
}

/** One second between postings — this reads a page per role, not an API. */
const limiter = new RateLimiter(1000);

/**
 * LinkedIn's public job-detail endpoint, the one its logged-out pages call.
 * Serves the full description with no account involved.
 */
function detailUrl(url: string): string | null {
    const id = url.match(/\/jobs\/view\/(?:[^/?]*-)?(\d{6,})/)?.[1] ?? url.match(/currentJobId=(\d{6,})/)?.[1];
    return id ? `https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${id}` : null;
}

function extract(html: string): { description: string; location: string | null } {
    const doc = new JSDOM(html, { virtualConsole: new VirtualConsole() }).window.document;

    // The description carries the workplace language; the topcard's location is
    // kept because a posting naming a city while claiming remote is itself worth
    // seeing next to the verdict.
    const description = doc.querySelector('.description__text')?.textContent ?? doc.body?.textContent ?? '';
    const flavors = [...doc.querySelectorAll('.topcard__flavor')].map((n) => n.textContent?.trim() ?? '');
    const location = flavors.find((f) => /,/.test(f)) ?? null;

    return { description, location };
}

export async function run(input: Input, ctx: ActorContext): Promise<void> {
    const { urls, keepVerdicts, maxConcurrent = 3 } = input;
    if (!Array.isArray(urls) || urls.length === 0) throw new Error('urls must be a non-empty array');

    const counts: Record<string, number> = {};
    let index = 0;

    const worker = async (): Promise<void> => {
        while (index < urls.length) {
            if (ctx.signal.aborted) return;
            const url = urls[index++];

            const detail = detailUrl(url);
            if (!detail) {
                ctx.log(`SKIP ${url} — not a recognised job link`);
                continue;
            }

            try {
                await limiter.take('www.linkedin.com');
                const { status, body } = await fetchText(detail, { signal: ctx.signal, session: ctx.runId });

                if (status !== 200) {
                    // A posting that has been taken down is worth reporting as
                    // such rather than silently dropping.
                    ctx.log(`SKIP ${url} — HTTP ${status}`);
                    await ctx.pushData({ url, verdict: 'unclear', evidence: '', note: `HTTP ${status}`, checkedAt: new Date().toISOString() });
                    counts.unclear = (counts.unclear ?? 0) + 1;
                    continue;
                }

                const { description, location } = extract(body);
                const assessment = classifyWorkplace(description);
                counts[assessment.verdict] = (counts[assessment.verdict] ?? 0) + 1;

                if (keepVerdicts && !keepVerdicts.includes(assessment.verdict)) continue;

                await ctx.pushData({
                    url,
                    verdict: assessment.verdict,
                    evidence: assessment.evidence,
                    postingLocation: location,
                    descriptionLength: description.length,
                    checkedAt: new Date().toISOString(),
                });
            } catch (err) {
                ctx.log(`FAILED ${url} — ${(err as Error).message}`);
            }
        }
    };

    await Promise.all(Array.from({ length: Math.min(maxConcurrent, urls.length) }, worker));
    ctx.log(`checked ${urls.length} posting(s): ${JSON.stringify(counts)}`);
}
