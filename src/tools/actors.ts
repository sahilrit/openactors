import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { type ActorIndex, searchActors } from '../registry.js';
import type { Runtime } from '../runtime.js';
import { openDataset } from '../storage.js';
import { resolveActorName } from '../aliases.js';
import type { ActorManifest } from '../types.js';
import { fail, previewItems, text } from './shared.js';

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

export function registerActorTools(server: McpServer, index: ActorIndex, runtime: Runtime): void {
    server.registerTool(
        'search-actors',
        {
            title: 'Search Actors',
            description:
                'Search available Actors (scrapers and data collectors) by keyword. Returns ' +
                "each Actor's id, title and description. Start here when you need to extract " +
                'data from the web. Pass an empty search to list everything available.',
            inputSchema: {
                search: z.string().default('').describe('Keywords, e.g. "job listings" or "crawl documentation".'),
                limit: z.number().int().min(1).max(100).default(20),
            },
        },
        async ({ search, limit }) => {
            const actors = await index.refresh();
            const results = searchActors(actors, search, limit);
            if (results.length === 0) {
                return text(`No Actors matched "${search}". Available: ${index.names()}`);
            }
            return text({ total: results.length, actors: results.map(describe) });
        },
    );

    server.registerTool(
        'fetch-actor-details',
        {
            title: 'Fetch Actor details',
            description:
                "Get the full JSON Schema for an Actor's input, plus its description. Call " +
                'this before call-actor so you know which fields are required and how they are named.',
            inputSchema: { actor: z.string().describe('Actor id, e.g. "jobs/ats-boards".') },
        },
        async ({ actor }) => {
            const manifest = index.find(actor, resolveActorName);
            if (!manifest) return fail(`Actor "${actor}" not found. Available: ${index.names()}`);
            return text({ ...describe(manifest), input: manifest.input });
        },
    );

    server.registerTool(
        'call-actor',
        {
            title: 'Call an Actor',
            description:
                'Run an Actor and return its results. The shape of `input` depends on the ' +
                'Actor — read it from fetch-actor-details first. Returns a preview of the items ' +
                'plus a datasetId for retrieving the rest via get-dataset-items. A run that ' +
                'partially fails still returns what it collected; check get-actor-log for detail.',
            inputSchema: {
                actor: z.string().describe('Actor id, e.g. "jobs/ats-boards".'),
                input: z.record(z.string(), z.unknown()).default({}).describe("The Actor's input object."),
                timeoutSecs: z.number().int().min(5).max(900).default(120),
                memoryMbytes: z
                    .number()
                    .int()
                    .min(128)
                    .max(16384)
                    .optional()
                    .describe('Heap ceiling for the Actor process. Raise it for a large crawl; a run that exceeds it is killed rather than exhausting the machine.'),
            },
        },
        async ({ actor, input, timeoutSecs, memoryMbytes }) => {
            const manifest = index.find(actor, resolveActorName);
            if (!manifest) return fail(`Actor "${actor}" not found. Available: ${index.names()}`);

            let record;
            try {
                record = await runtime.call(manifest, input, { timeoutSecs, memoryMbytes, origin: 'MCP' });
            } catch (err) {
                // Input validation failures read as a list of specific problems
                // rather than a stack trace, so an agent can correct the call
                // instead of guessing at it.
                return fail(`Could not start "${manifest.name}": ${(err as Error).message}`);
            }

            const dataset = await openDataset(record.defaultDatasetId);
            const { items } = await dataset.getData({ limit: 50 });
            const { shown, truncated } = previewItems(items);
            const more = truncated > 0 || record.itemCount > shown.length;

            return text({
                runId: record.id,
                actor: record.actorName,
                status: record.status,
                itemCount: record.itemCount,
                datasetId: record.defaultDatasetId,
                ...(record.errorMessage ? { error: record.errorMessage } : {}),
                ...(more
                    ? { note: `Showing ${shown.length} of ${record.itemCount} items. Use get-dataset-items with datasetId "${record.defaultDatasetId}" and an offset to read more.` }
                    : {}),
                items: shown,
            });
        },
    );
}
