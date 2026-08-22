#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './create-server.js';
import { discoverActors } from './registry.js';
import { Runtime } from './runtime.js';
import { configureStorage } from './storage.js';

async function main(): Promise<void> {
    configureStorage();

    const server = await createServer(new Runtime());
    await server.connect(new StdioServerTransport());

    // stdout is the MCP channel; anything human-facing must go to stderr.
    const actors = await discoverActors();
    console.error(`[openactors] ready — ${actors.length} actor(s): ${actors.map((a) => a.name).join(', ')}`);
}

main().catch((err) => {
    console.error('[openactors] fatal:', err);
    process.exit(1);
});
