#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { discoverActors, searchActors } from './registry.js';
import { Runtime } from './runtime.js';
import { configureStorage, openDataset } from './storage.js';
import { resolveActorName } from './aliases.js';
import type { ActorManifest } from './types.js';

/**
 * Budget for items echoed back inside a tool result. Scraped pages are large
 * and a tool result goes straight into an agent's context, so `call-actor`
 * returns a preview and points at `get-dataset-items` for the rest.
 */
const INLINE_CHAR_BUDGET = 20_000;

function text(payload: unknown) {
    const body = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
    return { content: [{ type: 'text' as const, text: body }] };
}

function fail(message: string) {
    return { content: [{ type: 'text' as const, text: message }], isError: true };
}

/** Trims a list of items to fit the inline budget, reporting what was withheld. */
function previewItems(items: unknown[]): { shown: unknown[]; truncated: number } {
    const shown: unknown[] = [];
    let used = 0;
    for (const item of items) {
        const size = JSON.stringify(item)?.length ?? 0;
        if (used + size > INLINE_CHAR_BUDGET && shown.length > 0) break;
        shown.push(item);
        used += size;
    }
    return { shown, truncated: items.length - shown.length };
}

function describe(actor: ActorManifest) {
    return {
        name: actor.name,
        title: actor.title,
        description: actor.description,
        tags: actor.tags,
        runnable: !actor.gatedReason,
        ...(actor.gatedReason ? { gatedReason: actor.gatedReason } : {}),
    };
}

async function main(): Promise<void> {
    configureStorage();

    const runtime = new Runtime();
    let actors = await discoverActors();

    const findActor = (requested: string): ActorManifest | undefined => {
        const name = resolveActorName(requested);
        return actors.find((a) => a.name === name);
    };

    const server = new McpServer(
        { name: 'openactors', version: '0.1.0' },
        {
            instructions:
                'Self-hosted web scraping Actors. Workflow: call search-actors to find an ' +
                'Actor, fetch-actor-details to read its input schema, then call-actor to run ' +
                'it. Results land in a dataset; page through them with get-dataset-items.',
        },
    );

    server.registerTool(
        'search-actors',
        {
            title: 'Search Actors',
            description:
                'Search available Actors (scrapers and crawlers) by keyword. Returns each ' +
                "Actor's id, title and description. Start here when you need to extract data " +
                'from a website. Pass an empty search to list everything available.',
            inputSchema: {
                search: z.string().default('').describe('Keywords, e.g. "job listings" or "crawl documentation".'),
                limit: z.number().int().min(1).max(100).default(20),
            },
        },
        async ({ search, limit }) => {
            // Pick up Actors added since boot without needing a server restart.
            actors = await discoverActors();
            const results = searchActors(actors, search, limit);
            if (results.length === 0) {
                return text(`No Actors matched "${search}". Available: ${actors.map((a) => a.name).join(', ')}`);
            }
            return text({ total: results.length, actors: results.map(describe) });
        },
    );

    server.registerTool(
        'fetch-actor-details',
        {
            title: 'Fetch Actor details',
            description:
                'Get the full JSON Schema for an Actor\'s input, plus its description. Call ' +
                'this before call-actor so you know which fields are required.',
            inputSchema: { actor: z.string().describe('Actor id, e.g. "web/site-crawler".') },
        },
        async ({ actor }) => {
            const manifest = findActor(actor);
            if (!manifest) {
                return fail(`Actor "${actor}" not found. Available: ${actors.map((a) => a.name).join(', ')}`);
            }
            return text({ ...describe(manifest), input: manifest.input });
        },
    );

    server.registerTool(
        'call-actor',
        {
            title: 'Call an Actor',
            description:
                'Run an Actor and return its results. The shape of `input` depends on the ' +
                'Actor — read it from fetch-actor-details first. Returns a preview of the ' +
                'items plus a datasetId for retrieving the rest via get-dataset-items.',
            inputSchema: {
                actor: z.string().describe('Actor id, e.g. "web/site-crawler".'),
                input: z.record(z.string(), z.unknown()).default({}).describe("The Actor's input object."),
                timeoutSecs: z.number().int().min(5).max(900).default(120),
            },
        },
        async ({ actor, input, timeoutSecs }) => {
            const manifest = findActor(actor);
            if (!manifest) {
                return fail(`Actor "${actor}" not found. Available: ${actors.map((a) => a.name).join(', ')}`);
            }

            let record;
            try {
                record = await runtime.call(manifest, input, timeoutSecs * 1000);
            } catch (err) {
                return fail(`Could not start "${manifest.name}": ${(err as Error).message}`);
            }

            const dataset = await openDataset(record.defaultDatasetId);
            const { items } = await dataset.getData({ limit: 50 });
            const { shown, truncated } = previewItems(items);

            return text({
                runId: record.id,
                actor: record.actorName,
                status: record.status,
                itemCount: record.itemCount,
                datasetId: record.defaultDatasetId,
                ...(record.errorMessage ? { error: record.errorMessage } : {}),
                ...(truncated > 0 || record.itemCount > shown.length
                    ? {
                          note: `Showing ${shown.length} of ${record.itemCount} items. Use get-dataset-items with datasetId "${record.defaultDatasetId}" and an offset to read more.`,
                      }
                    : {}),
                items: shown,
            });
        },
    );

    server.registerTool(
        'get-dataset-items',
        {
            title: 'Get dataset items',
            description:
                'Page through the results of a previous Actor run. Use the datasetId returned ' +
                'by call-actor. Use `fields` to project only the keys you need — this matters ' +
                'when items contain long text.',
            inputSchema: {
                datasetId: z.string(),
                offset: z.number().int().min(0).default(0),
                limit: z.number().int().min(1).max(200).default(10),
                fields: z.array(z.string()).optional().describe('Only return these top-level keys.'),
            },
        },
        async ({ datasetId, offset, limit, fields }) => {
            let dataset;
            try {
                dataset = await openDataset(datasetId);
            } catch {
                return fail(`Dataset "${datasetId}" not found.`);
            }

            const { items, total } = await dataset.getData({ offset, limit });
            const projected =
                fields && fields.length > 0
                    ? items.map((item) => Object.fromEntries(fields.filter((f) => f in item).map((f) => [f, item[f]])))
                    : items;
            const { shown, truncated } = previewItems(projected);

            return text({
                datasetId,
                total,
                offset,
                returned: shown.length,
                ...(truncated > 0
                    ? { note: `${truncated} item(s) withheld to fit the response budget. Narrow with \`fields\` or a smaller \`limit\`.` }
                    : {}),
                items: shown,
            });
        },
    );

    await server.connect(new StdioServerTransport());
    // stdout is the MCP channel; anything human-facing must go to stderr.
    console.error(`[openactors] ready — ${actors.length} actor(s): ${actors.map((a) => a.name).join(', ')}`);
}

main().catch((err) => {
    console.error('[openactors] fatal:', err);
    process.exit(1);
});
