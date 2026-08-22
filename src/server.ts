#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { ActorIndex } from './registry.js';
import { Runtime } from './runtime.js';
import { configureStorage } from './storage.js';
import { registerActorTools } from './tools/actors.js';
import { registerRunTools } from './tools/runs.js';
import { registerStorageTools } from './tools/storage.js';

async function main(): Promise<void> {
    configureStorage();

    const runtime = new Runtime();
    const index = new ActorIndex();
    await index.refresh();

    const server = new McpServer(
        { name: 'openactors', version: '0.1.0' },
        {
            instructions:
                'Self-hosted web scraping and data collection Actors. Workflow: search-actors ' +
                'to find an Actor, fetch-actor-details to read its input schema, then call-actor ' +
                'to run it. Results land in a dataset — page through them with get-dataset-items, ' +
                'and use get-actor-log if a run returned less than you expected.',
        },
    );

    registerActorTools(server, index, runtime);
    registerRunTools(server, runtime);
    registerStorageTools(server);

    await server.connect(new StdioServerTransport());
    // stdout is the MCP channel; anything human-facing must go to stderr.
    console.error(`[openactors] ready — ${index.all().length} actor(s): ${index.names()}`);
}

main().catch((err) => {
    console.error('[openactors] fatal:', err);
    process.exit(1);
});
