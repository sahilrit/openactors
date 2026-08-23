import { classifyEligibility } from '../../../src/geo.js';
import type { ActorContext } from '../../../src/types.js';
import { PROVIDERS, PROVIDER_NAMES, type NormalizedJob } from './providers.js';

interface Input {
    boards: string[];
    titleIncludes?: string[];
    remoteOnly?: boolean;
    locationIncludes?: string[];
    includeDescription?: boolean;
    maxDescriptionChars?: number;
    maxPerBoard?: number;
    eligibleFrom?: string;
    includeUnknownEligibility?: boolean;
}

const FETCH_TIMEOUT_MS = 25_000;

function matchesAny(haystack: string | null, needles: string[] | undefined): boolean {
    if (!needles || needles.length === 0) return true;
    if (haystack === null) return false;
    const lower = haystack.toLowerCase();
    return needles.some((n) => lower.includes(n.toLowerCase()));
}

export async function run(input: Input, ctx: ActorContext): Promise<void> {
    const {
        boards,
        titleIncludes,
        remoteOnly = false,
        locationIncludes,
        includeDescription = false,
        maxDescriptionChars = 2000,
        maxPerBoard = 200,
        eligibleFrom,
        includeUnknownEligibility = true,
    } = input;

    if (!Array.isArray(boards) || boards.length === 0) {
        throw new Error(`boards must be a non-empty array of "ats:account" strings. Valid ats values: ${PROVIDER_NAMES.join(', ')}`);
    }

    let totalKept = 0;

    for (const board of boards) {
        if (ctx.signal.aborted) {
            ctx.log('aborted; stopping');
            return;
        }

        // Split on the first colon only: account slugs are themselves url-safe,
        // but being strict here gives a better error than a confusing 404.
        const sep = board.indexOf(':');
        const atsName = (sep === -1 ? board : board.slice(0, sep)).trim().toLowerCase();
        const account = sep === -1 ? '' : board.slice(sep + 1).trim();

        const provider = PROVIDERS[atsName];
        if (!provider || account === '') {
            ctx.log(`SKIP "${board}": expected "ats:account" with ats one of ${PROVIDER_NAMES.join(', ')}`);
            continue;
        }

        const url = provider.url(account, includeDescription);
        let body: unknown;

        try {
            const res = await fetch(url, {
                signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]),
                headers: { accept: 'application/json', 'user-agent': 'openactors/0.1 (+https://github.com/)' },
            });
            if (!res.ok) {
                // A 404 almost always means a wrong account slug rather than an
                // outage, so say which board failed and keep going.
                ctx.log(`FAIL ${atsName}:${account} — HTTP ${res.status} (check the account slug)`);
                continue;
            }
            body = await res.json();
        } catch (err) {
            ctx.log(`FAIL ${atsName}:${account} — ${(err as Error).message}`);
            continue;
        }

        let raws: any[];
        try {
            raws = provider.extract(body);
        } catch (err) {
            ctx.log(`FAIL ${atsName}:${account} — unexpected response shape: ${(err as Error).message}`);
            continue;
        }

        const kept: NormalizedJob[] = [];
        for (const raw of raws) {
            if (kept.length >= maxPerBoard) break;

            let job: NormalizedJob;
            try {
                job = provider.normalize(raw, account);
            } catch (err) {
                // One malformed posting must not lose the rest of the board.
                ctx.log(`skipped a ${atsName} posting: ${(err as Error).message}`);
                continue;
            }

            if (!matchesAny(job.title, titleIncludes)) continue;
            if (!matchesAny(job.location, locationIncludes)) continue;
            if (remoteOnly && job.remote !== true) continue;

            if (eligibleFrom) {
                const verdict = classifyEligibility(job.location, eligibleFrom, job.workplaceType);
                // Unknown is kept by default. Most postings say only "Remote"
                // with the restriction, if any, buried in the description —
                // dropping them silently would hide real opportunities.
                if (verdict.eligibility === 'restricted') continue;
                if (verdict.eligibility === 'unknown' && !includeUnknownEligibility) continue;
                job.eligibility = verdict.eligibility;
                job.eligibilityReason = verdict.reason;
            }

            if (!includeDescription) {
                job.description = null;
            } else if (job.description && job.description.length > maxDescriptionChars) {
                job.description = `${job.description.slice(0, maxDescriptionChars)}…`;
            }

            kept.push(job);
        }

        if (kept.length > 0) await ctx.pushData(kept as unknown as Record<string, unknown>[]);
        totalKept += kept.length;
        ctx.log(`${atsName}:${account} — ${raws.length} posting(s), ${kept.length} kept${provider.verified ? '' : ' (provider adapter unverified)'}`);
    }

    ctx.log(`finished: ${totalKept} job(s) from ${boards.length} board(s)`);
}
