import { classifyEligibility } from '../../../src/geo.js';
import { fetchText } from '../../../src/fetcher.js';
import type { ActorContext } from '../../../src/types.js';
import { BOARDS, BOARD_NAMES, type RemoteJob } from './boards.js';

/** Bounds a paged walk, so a board that always returns a cursor cannot loop forever. */
const MAX_PAGES = 60;

interface Input {
    keywords?: string[];
    boards?: string[];
    eligibleFrom?: string;
    excludeRestricted?: boolean;
    postedWithinDays?: number;
    maxPerBoard?: number;
    worldwideOnly?: boolean;
}

/**
 * Matches on the title, and on the category only where a board curates one.
 *
 * Tags are deliberately excluded. RemoteOK's are close to noise — a retail
 * store role tagged "dev, node, math", a quality-systems role tagged
 * "marketing" — so matching them pulls in jobs that have nothing to do with
 * the search. The title is the one field every board gets right.
 */
function matches(job: RemoteJob, keywords: string[] | undefined): boolean {
    if (!keywords?.length) return true;
    const curatedCategory = job.board === 'remotive' ? job.category : null;
    const haystack = [job.title, curatedCategory].filter(Boolean).join(' ').toLowerCase();
    return keywords.some((k) => haystack.includes(k.toLowerCase()));
}

export async function run(input: Input, ctx: ActorContext): Promise<void> {
    const {
        keywords,
        boards = BOARD_NAMES,
        eligibleFrom,
        excludeRestricted = true,
        postedWithinDays,
        maxPerBoard = 100,
        worldwideOnly = false,
    } = input;

    const cutoff = postedWithinDays ? Date.now() - postedWithinDays * 86_400_000 : null;
    let total = 0;

    for (const name of boards) {
        if (ctx.signal.aborted) return;

        const board = BOARDS[name];
        if (!board) {
            ctx.log(`SKIP "${name}": unknown board. Available: ${BOARD_NAMES.join(', ')}`);
            continue;
        }

        // Paged boards are walked until they run dry or the cap is reached;
        // unpaged ones make exactly one request.
        const raws: any[] = [];
        let cursor: string | undefined;
        for (let page = 0; page < MAX_PAGES; page++) {
            if (ctx.signal.aborted) break;

            let body: unknown;
            try {
                const res = await fetchText(board.url(cursor), { signal: ctx.signal, session: ctx.runId, timeoutMs: 30_000 });
                if (res.status !== 200) {
                    ctx.log(`FAIL ${name} — HTTP ${res.status}`);
                    break;
                }
                body = JSON.parse(res.body);
            } catch (err) {
                // One board being down must not lose the others.
                ctx.log(`FAIL ${name} — ${(err as Error).message}`);
                break;
            }

            const batch = board.extract(body);
            raws.push(...batch);

            const next = board.nextCursor?.(body, batch.length) ?? null;
            if (!next || batch.length === 0 || raws.length >= maxPerBoard * 20) break;
            cursor = next;
        }
        const kept: RemoteJob[] = [];
        let droppedRestricted = 0;

        for (const raw of raws) {
            if (kept.length >= maxPerBoard) break;

            let job: RemoteJob;
            try {
                job = board.normalize(raw);
            } catch (err) {
                ctx.log(`skipped a ${name} row: ${(err as Error).message}`);
                continue;
            }

            if (!job.url || !job.title) continue;
            if (!matches(job, keywords)) continue;

            // A restriction naming a single city is a local job that reached a
            // remote board, not remote work — RemoteOK's feed carries plenty.
            if (worldwideOnly && !/worldwide|anywhere|global/i.test(job.restriction ?? '')) continue;
            if (cutoff && job.postedAt && Date.parse(job.postedAt) < cutoff) continue;

            if (eligibleFrom) {
                // The restriction is what these boards publish it for, so it is
                // the right field to judge on — not the company's own location.
                const verdict = classifyEligibility(job.restriction, eligibleFrom);
                job.eligibility = verdict.eligibility;
                job.eligibilityReason = verdict.reason;
                if (verdict.eligibility === 'restricted' && excludeRestricted) {
                    droppedRestricted++;
                    continue;
                }
            }

            kept.push(job);
        }

        if (kept.length > 0) await ctx.pushData(kept as unknown as Record<string, unknown>[]);
        total += kept.length;
        ctx.log(`${name} — ${raws.length} listing(s), ${kept.length} kept${droppedRestricted ? `, ${droppedRestricted} restricted elsewhere` : ''}`);
    }

    ctx.log(`finished: ${total} role(s) from ${boards.length} board(s)`);
}
