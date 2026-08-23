import { describe, expect, it, beforeEach } from 'vitest';
import { OpenActorsAuthProvider } from '../src/oauth.js';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';

const CLIENT: OAuthClientInformationFull = {
    client_id: 'client-1',
    redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
};

const PARAMS = {
    codeChallenge: 'challenge-abc',
    redirectUri: 'https://claude.ai/api/mcp/auth_callback',
    state: 'state-xyz',
};

let provider: OpenActorsAuthProvider;
beforeEach(() => {
    provider = new OpenActorsAuthProvider({ password: 'hunter2', issuer: 'https://example.test' });
});

describe('client registration', () => {
    it('mints a client id rather than trusting the one supplied', async () => {
        // A client that could choose its own id could claim an existing one.
        const registered = await provider.clientsStore.registerClient!({
            ...CLIENT, client_id: 'attacker-chosen',
        } as never);
        expect(registered.client_id).not.toBe('attacker-chosen');
        expect((await provider.clientsStore.getClient(registered.client_id))?.client_id).toBe(registered.client_id);
    });

    it('registers a public client, since MCP clients authenticate with PKCE not a secret', async () => {
        // Left to the RFC 7591 default the method is client_secret_basic, and
        // the token endpoint then rejects the exchange with "client secret is
        // required" — which is what actually happened.
        const registered = await provider.clientsStore.registerClient!({
            redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
        } as never);
        expect(registered.token_endpoint_auth_method).toBe('none');
        expect(registered.client_secret).toBeUndefined();
    });

    it('returns undefined for a client that was never registered', async () => {
        expect(await provider.clientsStore.getClient('nope')).toBeUndefined();
    });
});

describe('consent', () => {
    it('refuses to issue a code without the correct password', () => {
        const pending = provider.beginAuthorization(CLIENT, PARAMS);
        expect(() => provider.approve(pending, 'wrong-password')).toThrow(/password/i);
    });

    it('issues a code when the password is correct', () => {
        const pending = provider.beginAuthorization(CLIENT, PARAMS);
        expect(provider.approve(pending, 'hunter2')).toMatch(/\S/);
    });

    it('rejects an unknown pending authorization', () => {
        expect(() => provider.approve('never-issued', 'hunter2')).toThrow(/expired|unknown/i);
    });
});

describe('authorization code exchange', () => {
    async function codeFor(): Promise<string> {
        provider.putClient(CLIENT);
        return provider.approve(provider.beginAuthorization(CLIENT, PARAMS), 'hunter2');
    }

    it('returns the PKCE challenge that began the flow', async () => {
        expect(await provider.challengeForAuthorizationCode(CLIENT, await codeFor())).toBe('challenge-abc');
    });

    it('exchanges a code for an access token', async () => {
        const tokens = await provider.exchangeAuthorizationCode(CLIENT, await codeFor());
        expect(tokens.access_token).toMatch(/\S/);
        expect(tokens.token_type).toBe('Bearer');
        expect(tokens.expires_in).toBeGreaterThan(0);
    });

    it('refuses to exchange the same code twice', async () => {
        // A replayed code is the classic authorization-code attack; one use only.
        const code = await codeFor();
        await provider.exchangeAuthorizationCode(CLIENT, code);
        await expect(provider.exchangeAuthorizationCode(CLIENT, code)).rejects.toThrow();
    });

    it('refuses a code issued to a different client', async () => {
        const code = await codeFor();
        const other = { ...CLIENT, client_id: 'client-2' };
        await expect(provider.exchangeAuthorizationCode(other, code)).rejects.toThrow();
    });

    it('refuses an unknown code', async () => {
        await expect(provider.exchangeAuthorizationCode(CLIENT, 'not-a-code')).rejects.toThrow();
    });
});

describe('access tokens', () => {
    async function tokenFor(): Promise<string> {
        provider.putClient(CLIENT);
        const code = provider.approve(provider.beginAuthorization(CLIENT, PARAMS), 'hunter2');
        return (await provider.exchangeAuthorizationCode(CLIENT, code)).access_token;
    }

    it('verifies a token it issued', async () => {
        const info = await provider.verifyAccessToken(await tokenFor());
        expect(info.clientId).toBe('client-1');
        expect(info.token).toMatch(/\S/);
    });

    it('rejects a token it never issued', async () => {
        await expect(provider.verifyAccessToken('forged-token')).rejects.toThrow();
    });

    it('rejects a revoked token', async () => {
        const token = await tokenFor();
        await provider.revokeToken!(CLIENT, { token });
        await expect(provider.verifyAccessToken(token)).rejects.toThrow();
    });

    it('rejects an expired token', async () => {
        const short = new OpenActorsAuthProvider({ password: 'p', issuer: 'https://x.test', tokenTtlSecs: -1 });
        short.putClient(CLIENT);
        const code = short.approve(short.beginAuthorization(CLIENT, PARAMS), 'p');
        const { access_token } = await short.exchangeAuthorizationCode(CLIENT, code);
        await expect(short.verifyAccessToken(access_token)).rejects.toThrow(/expired/i);
    });
});

describe('persistence across restarts', () => {
    it('restores clients and tokens so a restart does not break the connector', async () => {
        // Claude registers once and keeps its token. If a restart forgot both,
        // every connector call would 401 and the user would have to re-add it.
        const first = new OpenActorsAuthProvider({ password: 'hunter2', issuer: 'https://x.test' });
        const client = await first.clientsStore.registerClient!({
            redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
        } as never);
        const code = first.approve(first.beginAuthorization(client, PARAMS), 'hunter2');
        const { access_token } = await first.exchangeAuthorizationCode(client, code);

        const snapshot = first.snapshot();

        const second = new OpenActorsAuthProvider({ password: 'hunter2', issuer: 'https://x.test' });
        second.restore(snapshot);

        expect((await second.clientsStore.getClient(client.client_id))?.client_id).toBe(client.client_id);
        expect((await second.verifyAccessToken(access_token)).clientId).toBe(client.client_id);
    });

    it('does not restore authorization codes, which are single-use and short-lived', async () => {
        const first = new OpenActorsAuthProvider({ password: 'p', issuer: 'https://x.test' });
        first.putClient(CLIENT);
        const code = first.approve(first.beginAuthorization(CLIENT, PARAMS), 'p');

        const second = new OpenActorsAuthProvider({ password: 'p', issuer: 'https://x.test' });
        second.restore(first.snapshot());

        await expect(second.exchangeAuthorizationCode(CLIENT, code)).rejects.toThrow();
    });
});
