#!/usr/bin/env node
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer } from './create-server.js';
import { ActorIndex, discoverActors } from './registry.js';
import { consoleHtml } from './console.js';
import { getProxyConfiguration } from './proxy.js';
import { handleRest } from './rest.js';
import { resolveActorName } from './aliases.js';
import { Scheduler } from './schedules.js';
import { Runtime } from './runtime.js';
import { configureStorage } from './storage.js';

const PORT = Number(process.env.PORT ?? 8080);
const AUTH_TOKEN = process.env.AUTH_TOKEN ?? null;

/**
 * Remote transport, for running this somewhere other than the machine holding
 * the MCP client.
 *
 * Stateless, like Apify's hosted server: each request gets its own server and
 * transport, so there is no session state to lose on restart or to pin a client
 * to one instance. The Runtime is deliberately *not* per-request — it holds run
 * history, which must outlive the call that created it or `get-actor-run` would
 * never find the run that `call-actor` just reported.
 */
const runtime = new Runtime();
const index = new ActorIndex();
const scheduler = new Scheduler({
    runtime,
    resolveActor: (name) => index.find(name, resolveActorName),
    refresh: () => index.refresh(),
});

function unauthorized(res: ServerResponse): void {
    res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer' });
    res.end(JSON.stringify({ error: 'unauthorized' }));
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    // The console is served unauthenticated; every call it makes carries the
    // token, so the page itself reveals nothing without one.
    if (url.pathname === '/' || url.pathname === '/console') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(await consoleHtml());
        return;
    }

    if (url.pathname === '/health') {
        const proxies = await getProxyConfiguration();
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
            JSON.stringify({
                status: 'ok',
                actors: (await discoverActors()).map((a) => a.name),
                // Enough to confirm a proxy is actually in use; never the
                // credentials, which would otherwise leak from an endpoint
                // that exists to be curl'd.
                proxy: proxies?.enabled ? { enabled: true, ...proxies.stats() } : { enabled: false },
                runs: runtime.capacity(),
            }),
        );
        return;
    }

    // This server can run arbitrary scrapers, so it must not be left open when
    // exposed beyond localhost. AUTH_TOKEN is optional to keep local use
    // frictionless, and the startup log warns loudly when it is unset. Checked
    // before routing so REST and MCP are equally protected.
    if (AUTH_TOKEN && req.headers.authorization !== `Bearer ${AUTH_TOKEN}`) {
        unauthorized(res);
        return;
    }

    // REST first; it reports whether the path was its own.
    if (await handleRest(req, res, { runtime, index, scheduler })) return;

    if (url.pathname !== '/mcp') {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found', hint: 'MCP is at /mcp, REST under /v2, health at /health' }));
        return;
    }

    const server = await createServer(runtime);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

    // Per-request objects must be torn down with the request, or each call
    // leaks a server and its listeners.
    res.on('close', () => {
        void transport.close();
        void server.close();
    });

    await server.connect(transport);
    await transport.handleRequest(req, res);
}

createHttpServer((req, res) => {
    handle(req, res).catch((err) => {
        console.error('[openactors] request failed:', err);
        if (!res.headersSent) {
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'internal error' }));
        }
    });
}).listen(PORT, async () => {
    configureStorage();
    // Run history is read once at startup so a REST caller can inspect runs
    // started by a previous process or by the scheduler.
    await runtime.load();
    await index.refresh();
    runtime.resolveActor = (name) => index.find(name, resolveActorName);
    scheduler.start();
    console.log(`[openactors] http listening on :${PORT} — MCP at /mcp, REST at /v2, health at /health`);
    if (!AUTH_TOKEN) {
        console.warn('[openactors] WARNING: AUTH_TOKEN is not set. Do not expose this port beyond localhost.');
    }
});
