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
check('tools registered', names.length === 4, names.join(', '));
check(
    'Apify-compatible tool names',
    ['call-actor', 'fetch-actor-details', 'get-dataset-items', 'search-actors'].every((n) => names.includes(n)),
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

await client.close();
console.log(`\n${failures === 0 ? 'ALL PASSED' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
