#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './create-server.js';
import { discoverActors } from './registry.js';
import { Runtime } from './runtime.js';
import { configureStorage } from './storage.js';

async function main(): Promise<void> {
    configureStorage();

    const runtime = new Runtime();
    // Restores persisted history, so get-actor-run finds runs from the
    // scheduler or a previous session rather than only this process's.
    await runtime.load();

    const server = await createServer(runtime);
    await server.connect(new StdioServerTransport());

    // stdout is the MCP channel; anything human-facing must go to stderr.
    const actors = await discoverActors();
    console.error(`[openactors] ready — ${actors.length} actor(s): ${actors.map((a) => a.name).join(', ')}`);
}

main().catch((err) => {
    console.error('[openactors] fatal:', err);
    process.exit(1);
});
