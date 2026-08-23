import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { resolveActorName } from './aliases.js';
import { ActorIndex } from './registry.js';
import { Runtime } from './runtime.js';
import { registerActorTools } from './tools/actors.js';
import { registerRunTools } from './tools/runs.js';
import { registerStorageTools } from './tools/storage.js';
import { registerScheduleTools } from './tools/schedules.js';
import { registerTaskTools } from './tools/tasks.js';

const INSTRUCTIONS =
    'Self-hosted web scraping and data collection Actors. Workflow: search-actors ' +
    'to find an Actor, fetch-actor-details to read its input schema, then call-actor ' +
    'to run it. Results land in a dataset — page through them with get-dataset-items, ' +
    'and use get-actor-log if a run returned less than you expected.';

/**
 * Builds a configured MCP server.
 *
 * Both entry points use this: stdio creates one for the process lifetime, while
 * the HTTP transport creates one per request because it runs statelessly. The
 * Runtime is passed in rather than created here so the HTTP server can share
 * one across requests — otherwise every request would get a fresh, empty run
 * history and `get-actor-run` could never find anything.
 */
export async function createServer(runtime: Runtime): Promise<McpServer> {
    const index = new ActorIndex();
    await index.refresh();

    // Lets an Actor call another. Injected here so the Runtime itself keeps no
    // dependency on the registry.
    runtime.resolveActor = (name) => index.find(name, resolveActorName);

    const server = new McpServer({ name: 'openactors', version: '0.1.0' }, { instructions: INSTRUCTIONS });

    registerActorTools(server, index, runtime);
    registerRunTools(server, runtime);
    registerStorageTools(server);
    registerTaskTools(server, index, runtime);
    registerScheduleTools(server);

    return server;
}
