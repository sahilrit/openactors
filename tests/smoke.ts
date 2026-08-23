/**
 * End-to-end smoke test: speaks real MCP over stdio to the server, exactly as
 * Claude Code would. Proves the wire contract and a live crawl, which unit
 * tests cannot.
 *
 * Run: npx tsx tests/smoke.ts
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
function check(label: string, ok: boolean, detail = '') {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
    if (!ok) failures++;
}

function payload(result: any): any {
    const raw = result.content?.[0]?.text ?? '';
    try {
        return JSON.parse(raw);
    } catch {
        return raw;
    }
}

const client = new Client({ name: 'smoke', version: '1.0.0' });
await client.connect(
    new StdioClientTransport({ command: 'npx', args: ['tsx', resolve(ROOT, 'src/server.ts')], cwd: ROOT }),
);

const { tools } = await client.listTools();
const names = tools.map((t) => t.name).sort();
check('tools registered', names.length === 20, `${names.length}: ${names.join(', ')}`);
check(
    'Apify-compatible tool names',
    ['call-actor', 'fetch-actor-details', 'get-dataset-items', 'search-actors', 'get-actor-run',
     'get-actor-log', 'abort-actor-run', 'get-dataset', 'get-dataset-schema',
     'get-key-value-store-record', 'get-actor-run-list', 'create-actor-task', 'get-actor-task',
     'delete-actor-task', 'run-actor-task', 'resurrect-actor-run', 'create-schedule',
     'get-schedules', 'delete-schedule', 'clean-up-storage'].every((n) => names.includes(n)),
);

const search = payload(await client.callTool({ name: 'search-actors', arguments: { search: 'markdown crawl' } }));
check('search-actors finds the crawler', search.actors?.[0]?.name === 'web/site-crawler', JSON.stringify(search.actors?.[0]?.name));

const details = payload(await client.callTool({ name: 'fetch-actor-details', arguments: { actor: 'web/site-crawler' } }));
check('input schema exposed', details.input?.required?.includes('startUrls'), JSON.stringify(details.input?.required));

console.log('\n… running a live crawl, this takes a few seconds\n');
const run = payload(
    await client.callTool({
        name: 'call-actor',
        arguments: {
            actor: 'web/site-crawler',
            input: { startUrls: ['https://example.com/'], maxPages: 1, maxDepth: 0 },
            timeoutSecs: 60,
        },
    }),
);
check('run succeeded', run.status === 'SUCCEEDED', `${run.status} ${run.error ?? ''}`);
check('items produced', run.itemCount >= 1, `itemCount=${run.itemCount}`);
check('markdown extracted', typeof run.items?.[0]?.markdown === 'string' && run.items[0].markdown.length > 20,
    JSON.stringify(run.items?.[0]?.markdown?.slice(0, 60)));

const items = payload(await client.callTool({ name: 'get-dataset-items', arguments: { datasetId: run.datasetId, fields: ['url', 'title'] } }));
check('dataset readable after run', items.total >= 1 && items.items?.[0]?.url?.includes('example.com'), JSON.stringify(items.items?.[0]));
check('field projection works', items.items?.[0] && !('markdown' in items.items[0]), Object.keys(items.items?.[0] ?? {}).join(','));

const aliased = payload(
    await client.callTool({ name: 'fetch-actor-details', arguments: { actor: 'apify/website-content-crawler' } }),
);
check('Apify actor-id alias resolves', aliased.name === 'web/site-crawler', JSON.stringify(aliased.name ?? aliased));

const missing = await client.callTool({ name: 'fetch-actor-details', arguments: { actor: 'apify/instagram-scraper' } });
check('unknown actor fails clearly', missing.isError === true && String((missing as any).content[0].text).includes('not found'));

// Regression guard: Crawlee's default request queue persists across runs, so an
// Actor reusing it crawls nothing the second time. Every run must stand alone.
const second = payload(
    await client.callTool({
        name: 'call-actor',
        arguments: {
            actor: 'web/site-crawler',
            input: { startUrls: ['https://example.com/'], maxPages: 1, maxDepth: 0 },
            timeoutSecs: 60,
        },
    }),
);
check('repeat run still returns items', second.itemCount >= 1, `itemCount=${second.itemCount}`);
check('repeat run uses a fresh dataset', second.datasetId !== run.datasetId);

// Link-following: proves enqueueLinks and depth accounting actually work.
console.log('\n… multi-page crawl\n');
const multi = payload(
    await client.callTool({
        name: 'call-actor',
        arguments: {
            actor: 'web/site-crawler',
            input: { startUrls: ['https://crawlee.dev/js/docs/quick-start'], maxPages: 3, maxDepth: 1 },
            timeoutSecs: 180,
        },
    }),
);
check('follows links to more pages', multi.itemCount >= 2, `itemCount=${multi.itemCount}`);
check('depth is tracked', (multi.items ?? []).some((i: any) => i.depth === 1),
    JSON.stringify((multi.items ?? []).map((i: any) => i.depth)));

// --- run tools -------------------------------------------------------------
const runInfo = payload(await client.callTool({ name: 'get-actor-run', arguments: { runId: run.runId } }));
check('get-actor-run returns the run', runInfo.id === run.runId && runInfo.status === 'SUCCEEDED', runInfo.status);

const runLog = payload(await client.callTool({ name: 'get-actor-log', arguments: { runId: run.runId } }));
check('get-actor-log returns output', typeof runLog === 'string' && runLog.includes('crawled'), String(runLog).slice(0, 60));

const runList = payload(await client.callTool({ name: 'get-actor-run-list', arguments: {} }));
check('get-actor-run-list lists runs', runList.total >= 3, `total=${runList.total}`);

const badRun = await client.callTool({ name: 'get-actor-run', arguments: { runId: 'run-does-not-exist' } });
check('unknown run fails clearly', badRun.isError === true);

// --- storage tools ---------------------------------------------------------
const meta = payload(await client.callTool({ name: 'get-dataset', arguments: { datasetId: run.datasetId } }));
check('get-dataset returns a count', meta.itemCount === 1, `itemCount=${meta.itemCount}`);

const schema = payload(await client.callTool({ name: 'get-dataset-schema', arguments: { datasetId: run.datasetId } }));
check('get-dataset-schema infers fields',
    schema.schema?.properties?.markdown?.type === 'string' && schema.schema?.properties?.url?.type === 'string',
    JSON.stringify(Object.keys(schema.schema?.properties ?? {})));

// --- ats-boards ------------------------------------------------------------
console.log('\n… fetching live ATS job boards\n');
const jobs = payload(
    await client.callTool({
        name: 'call-actor',
        arguments: {
            actor: 'jobs/ats-boards',
            input: {
                boards: ['greenhouse:stripe', 'lever:leverdemo', 'ashby:ashby', 'nonsense:xyz'],
                titleIncludes: ['marketing', 'growth'],
            },
            timeoutSecs: 180,
        },
    }),
);
check('ats-boards returns jobs', jobs.status === 'SUCCEEDED' && jobs.itemCount > 5, `${jobs.status} itemCount=${jobs.itemCount}`);
check('jobs are normalized across providers',
    new Set((jobs.items ?? []).map((j: any) => j.ats)).size >= 2,
    JSON.stringify([...new Set((jobs.items ?? []).map((j: any) => j.ats))]));
check('every job has a title and url',
    (jobs.items ?? []).every((j: any) => j.title && /^https?:/.test(j.url)));
check('descriptions omitted by default', (jobs.items ?? []).every((j: any) => j.description === null));

const jobLog = payload(await client.callTool({ name: 'get-actor-log', arguments: { runId: jobs.runId } }));
check('bad board is reported in the log, not fatal', String(jobLog).includes('SKIP "nonsense:xyz"'),
    String(jobLog).split('\n').find((l: string) => l.includes('nonsense'))?.slice(0, 70));

const remote = payload(
    await client.callTool({
        name: 'call-actor',
        arguments: {
            actor: 'jobs/ats-boards',
            input: { boards: ['greenhouse:stripe'], titleIncludes: ['marketing'], remoteOnly: true },
            timeoutSecs: 120,
        },
    }),
);
check('remoteOnly filters to remote roles',
    remote.itemCount > 0 && (remote.items ?? []).every((j: any) => j.remote === true),
    `itemCount=${remote.itemCount}`);

// Regression: Ashby's isRemote is true for hybrid roles, so remoteOnly used to
// return office jobs. workplaceType is the field that actually distinguishes.
const remoteAshby = payload(
    await client.callTool({
        name: 'call-actor',
        arguments: {
            actor: 'jobs/ats-boards',
            input: { boards: ['ashby:ramp', 'ashby:replit'], titleIncludes: ['growth'], remoteOnly: true },
            timeoutSecs: 180,
        },
    }),
);
check('remoteOnly excludes hybrid and onsite roles',
    (remoteAshby.items ?? []).every((j: any) => !j.workplaceType || j.workplaceType === 'Remote'),
    JSON.stringify([...new Set((remoteAshby.items ?? []).map((j: any) => j.workplaceType))]));

// --- rag-browser -----------------------------------------------------------
console.log('\n… live web search\n');
const searched = payload(
    await client.callTool({
        name: 'call-actor',
        arguments: {
            actor: 'apify/rag-web-browser', // exercises the alias too
            input: { query: 'crawlee playwright crawler documentation', maxResults: 3, maxCharsPerPage: 500 },
            timeoutSecs: 240,
        },
    }),
);
check('rag-browser searches and fetches', searched.status === 'SUCCEEDED' && searched.itemCount >= 1,
    `${searched.status} itemCount=${searched.itemCount}`);
check('results carry url and markdown',
    (searched.items ?? []).every((i: any) => /^https?:/.test(i.url) && typeof i.markdown === 'string'));

const direct = payload(
    await client.callTool({
        name: 'call-actor',
        arguments: { actor: 'web/rag-browser', input: { urls: ['https://example.com/'], fetchContent: true }, timeoutSecs: 90 },
    }),
);
check('rag-browser fetches explicit urls without searching', direct.itemCount === 1, `itemCount=${direct.itemCount}`);

// --- google-maps -----------------------------------------------------------
console.log('\n… google maps (drives a real browser)\n');
const maps = payload(
    await client.callTool({
        name: 'call-actor',
        arguments: { actor: 'maps/google-maps', input: { query: 'plumbers in Austin TX', maxResults: 5 }, timeoutSecs: 300 },
    }),
);
check('maps returns businesses', maps.status === 'SUCCEEDED' && maps.itemCount >= 3,
    `${maps.status} itemCount=${maps.itemCount} ${maps.error ?? ''}`);
check('businesses have a name and a maps url',
    (maps.items ?? []).every((b: any) => b.name && /^https:\/\/www\.google\.com\/maps\//.test(b.mapsUrl)));
check('contact details extracted for most listings',
    (maps.items ?? []).filter((b: any) => b.phone).length >= Math.ceil((maps.items ?? []).length / 2),
    `${(maps.items ?? []).filter((b: any) => b.phone).length}/${(maps.items ?? []).length} have phones`);

// --- linkedin ---------------------------------------------------------------
console.log('\n… linkedin public job search\n');
const li = payload(
    await client.callTool({
        name: 'call-actor',
        arguments: {
            actor: 'linkedin/jobs',
            input: { keywords: 'performance marketing', location: 'United Kingdom', postedWithinDays: 30, maxResults: 15 },
            timeoutSecs: 300,
        },
    }),
);
check('linkedin runs with no credential', li.status === 'SUCCEEDED' && li.itemCount >= 10,
    `${li.status} itemCount=${li.itemCount} ${li.error ?? ''}`);
check('listings carry title, company and a job url',
    (li.items ?? []).every((j: any) => j.title && j.company && /linkedin\.com\/jobs\/view\//.test(j.url)));
check('urls are free of tracking params, so paging deduplicates',
    (li.items ?? []).every((j: any) => !j.url.includes('?')) &&
        new Set((li.items ?? []).map((j: any) => j.url)).size === (li.items ?? []).length);
check('posted dates are ISO', (li.items ?? []).filter((j: any) => j.postedAt).every((j: any) => /^\d{4}-\d{2}-\d{2}T/.test(j.postedAt)));

const liLog = payload(await client.callTool({ name: 'get-actor-log', arguments: { runId: li.runId } }));
// The second page must contribute new rows, not repeats — that is what proves
// the offset advances correctly. The exact count varies because the run stops
// at maxResults, so assert "more than zero", not a fixed number.
const secondPage = String(liLog).split('\n').find((l) => l.includes('start=10:'));
check('a second page contributes new listings rather than repeats',
    /(\d+) new/.exec(secondPage ?? '')?.[1] !== undefined && Number(/(\d+) new/.exec(secondPage ?? '')![1]) > 0,
    secondPage?.slice(24, 90));
check('no duplicate listings across pages',
    new Set((li.items ?? []).map((j: any) => j.id)).size === (li.items ?? []).length,
    `${new Set((li.items ?? []).map((j: any) => j.id)).size} unique of ${(li.items ?? []).length}`);

// --- geographic eligibility -------------------------------------------------
console.log('\n… geographic eligibility filter\n');
const BOARDS = ['greenhouse:gitlab', 'greenhouse:webflow', 'ashby:linear'];
const KW = ['growth', 'marketing', 'demand generation'];

async function boardRun(extra: Record<string, unknown>) {
    const res = payload(
        await client.callTool({
            name: 'call-actor',
            arguments: { actor: 'jobs/ats-boards', input: { boards: BOARDS, titleIncludes: KW, ...extra }, timeoutSecs: 240 },
        }),
    );
    const items = payload(
        await client.callTool({
            name: 'get-dataset-items',
            arguments: { datasetId: res.datasetId, limit: 200, fields: ['title', 'location', 'eligibility', 'eligibilityReason'] },
        }),
    );
    return items.items ?? [];
}

const unfiltered = await boardRun({ remoteOnly: true });
const forIndia = await boardRun({ remoteOnly: true, eligibleFrom: 'IN' });
const forUs = await boardRun({ remoteOnly: true, eligibleFrom: 'US' });

check('eligibility filter narrows the list', forIndia.length < unfiltered.length,
    `${unfiltered.length} remote -> ${forIndia.length} open from IN`);
check('nothing restricted survives the filter',
    forIndia.every((j: any) => j.eligibility !== 'restricted'),
    JSON.stringify([...new Set(forIndia.map((j: any) => j.eligibility))]));
check('every surviving row explains itself',
    forIndia.every((j: any) => typeof j.eligibilityReason === 'string' && j.eligibilityReason.length > 0));

// The filter must depend on the candidate's country, not merely reject
// everything: these US-remote roles are closed to India and open to the US.
check('the same roles resolve differently by country', forUs.length > forIndia.length,
    `IN=${forIndia.length} US=${forUs.length}`);
check('US-remote roles are open to a US candidate',
    forUs.some((j: any) => j.eligibility === 'open'),
    JSON.stringify(forUs.slice(0, 1).map((j: any) => [j.location, j.eligibility])));

// --- input validation --------------------------------------------------------
const badInput = await client.callTool({
    name: 'call-actor',
    arguments: { actor: 'jobs/ats-boards', input: { boards: 'not-an-array', typoField: 1 } },
});
check('invalid input is refused before the run starts', badInput.isError === true &&
    /unknown field "typoField"/.test(String((badInput as any).content[0].text)),
    String((badInput as any).content[0].text).slice(0, 90));

// --- tasks -------------------------------------------------------------------
const created = payload(await client.callTool({
    name: 'create-actor-task',
    arguments: { id: 'smoke-task', actor: 'jobs/ats-boards', input: { boards: ['ashby:linear'], titleIncludes: ['engineer'] } },
}));
check('task saved', created.id === 'smoke-task' && created.actor === 'jobs/ats-boards');

const taskRun = payload(await client.callTool({
    name: 'run-actor-task', arguments: { id: 'smoke-task', input: { titleIncludes: ['designer'] } },
}));
check('task runs with overrides applied', taskRun.status === 'SUCCEEDED' &&
    JSON.stringify((taskRun.input as any).titleIncludes) === '["designer"]',
    `${taskRun.status} ${JSON.stringify((taskRun.input as any)?.titleIncludes)}`);

// --- resurrection ------------------------------------------------------------
const revived = payload(await client.callTool({ name: 'resurrect-actor-run', arguments: { runId: taskRun.id } }));
check('run resurrects into a new run', revived.id !== taskRun.id && revived.resurrectedFrom === taskRun.id,
    `${revived.id} from ${revived.resurrectedFrom}`);
check('resurrected run is marked as such', revived.origin === 'RESURRECTION', revived.origin);

const cleaned = await client.callTool({ name: 'delete-actor-task', arguments: { id: 'smoke-task' } });
check('task deleted', cleaned.isError !== true);

// --- any-language Actors -----------------------------------------------------
console.log('\n… python actor\n');
const py = payload(
    await client.callTool({
        name: 'call-actor',
        arguments: {
            actor: 'web/rss-reader',
            input: { feedUrls: ['https://crawlee.dev/blog/rss.xml', 'https://not-a-real-feed.invalid/x'], maxPerFeed: 3 },
            timeoutSecs: 120,
        },
    }),
);
check('a Python Actor runs through the same pipeline', py.status === 'SUCCEEDED' && py.itemCount >= 1,
    `${py.status} itemCount=${py.itemCount} ${py.error ?? ''}`);
check('its items are structured, not raw text',
    (py.items ?? []).every((i: any) => typeof i.title === 'string' && 'link' in i));

const pyLog = payload(await client.callTool({ name: 'get-actor-log', arguments: { runId: py.runId } }));
check('one unreachable feed does not fail the run', /FAILED .*invalid/.test(String(pyLog)),
    String(pyLog).split('\n').find((l: string) => l.includes('FAILED'))?.slice(24, 90));

// --- schedules ---------------------------------------------------------------
const sched = payload(await client.callTool({
    name: 'create-schedule',
    arguments: { id: 'smoke-schedule', cron: '0 */6 * * *', actor: 'jobs/ats-boards', input: { boards: ['ashby:linear'] } },
}));
check('schedule created with a computed next run', sched.id === 'smoke-schedule' && Boolean(sched.nextRunAt), sched.nextRunAt);

const badCron = await client.callTool({
    name: 'create-schedule', arguments: { id: 'smoke-bad', cron: 'every tuesday', actor: 'jobs/ats-boards' },
});
check('an unparseable cron is refused at creation', badCron.isError === true,
    String((badCron as any).content[0].text).slice(0, 70));

const listed = payload(await client.callTool({ name: 'get-schedules', arguments: {} }));
check('schedule is listed', (listed.schedules ?? []).some((s: any) => s.id === 'smoke-schedule'));
check('schedule cleaned up',
    (await client.callTool({ name: 'delete-schedule', arguments: { id: 'smoke-schedule' } })).isError !== true);

// --- storage retention -------------------------------------------------------
const swept = payload(await client.callTool({ name: 'clean-up-storage', arguments: { keepDays: 365, dryRun: true } }));
check('a dry run reports without deleting', swept.dryRun === true && swept.removedCount === 0,
    `removed=${swept.removedCount} kept=${swept.keptCount}`);

await client.close();
console.log(`\n${failures === 0 ? 'ALL PASSED' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
