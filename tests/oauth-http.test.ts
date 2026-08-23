import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOAuthHandler } from '../src/oauth-http.js';
import { OpenActorsAuthProvider } from '../src/oauth.js';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Exercises the endpoints Claude's connector actually calls when it discovers
 * and authorises a remote MCP server.
 */
let server: Server;
let base = '';
let provider: OpenActorsAuthProvider;

beforeAll(async () => {
    provider = new OpenActorsAuthProvider({ password: 'hunter2', issuer: 'http://127.0.0.1' });
    const handler = createOAuthHandler(provider, () => base);

    server = createServer((req, res) => {
        void handler(req, res).then((handled) => {
            if (!handled) {
                res.writeHead(404, { 'content-type': 'application/json' });
                res.end('{"error":"not found"}');
            }
        });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
});

describe('discovery', () => {
    it('publishes protected resource metadata pointing at its authorization server', async () => {
        const res = await fetch(base + '/.well-known/oauth-protected-resource');
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.resource).toBe(base + '/mcp');
        expect(body.authorization_servers).toContain(base);
    });

    it('publishes authorization server metadata with the endpoints Claude needs', async () => {
        const res = await fetch(base + '/.well-known/oauth-authorization-server');
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.authorization_endpoint).toBe(base + '/oauth/authorize');
        expect(body.token_endpoint).toBe(base + '/oauth/token');
        expect(body.registration_endpoint).toBe(base + '/oauth/register');
        // Claude uses authorization code with PKCE.
        expect(body.code_challenge_methods_supported).toContain('S256');
    });
});

describe('dynamic client registration', () => {
    it('registers a client and returns its id', async () => {
        const res = await fetch(base + '/oauth/register', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ redirect_uris: ['https://claude.ai/api/mcp/auth_callback'], client_name: 'Claude' }),
        });
        expect(res.status).toBe(201);
        const body = await res.json();
        expect(body.client_id).toMatch(/\S/);
        expect(await provider.clientsStore.getClient(body.client_id)).toBeDefined();
    });
});

describe('the consent screen', () => {
    async function registerClient(): Promise<string> {
        const res = await fetch(base + '/oauth/register', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] }),
        });
        return (await res.json()).client_id;
    }

    it('asks for a password instead of redirecting straight back', async () => {
        // Auto-approving would let anyone who found the URL mint a token.
        const clientId = await registerClient();
        const url = new URL(base + '/oauth/authorize');
        url.searchParams.set('client_id', clientId);
        url.searchParams.set('redirect_uri', 'https://claude.ai/api/mcp/auth_callback');
        url.searchParams.set('response_type', 'code');
        url.searchParams.set('code_challenge', 'abc');
        url.searchParams.set('code_challenge_method', 'S256');

        const res = await fetch(url, { redirect: 'manual' });
        expect(res.status).toBe(200);
        const html = await res.text();
        expect(html).toContain('type="password"');
        expect(html).toContain('name="pending"');
    });

    it('rejects a wrong password without redirecting', async () => {
        const clientId = await registerClient();
        const client = (await provider.clientsStore.getClient(clientId))!;
        const pending = provider.beginAuthorization(client, {
            codeChallenge: 'abc', redirectUri: 'https://claude.ai/api/mcp/auth_callback',
        });

        const res = await fetch(base + '/oauth/approve', {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ pending, password: 'wrong' }).toString(),
            redirect: 'manual',
        });
        expect(res.status).toBe(401);
        expect(await res.text()).toMatch(/incorrect/i);
    });

    it('redirects back with a code and the original state when the password is right', async () => {
        const clientId = await registerClient();
        const client = (await provider.clientsStore.getClient(clientId))!;
        const pending = provider.beginAuthorization(client, {
            codeChallenge: 'abc', redirectUri: 'https://claude.ai/api/mcp/auth_callback', state: 'state-123',
        });

        const res = await fetch(base + '/oauth/approve', {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ pending, password: 'hunter2' }).toString(),
            redirect: 'manual',
        });
        expect(res.status).toBe(302);

        const location = new URL(res.headers.get('location')!);
        expect(location.origin + location.pathname).toBe('https://claude.ai/api/mcp/auth_callback');
        expect(location.searchParams.get('code')).toMatch(/\S/);
        // State must round-trip or the client rejects the callback as forged.
        expect(location.searchParams.get('state')).toBe('state-123');
    });
});
