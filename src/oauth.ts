import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { Response } from 'express';
import type { OAuthServerProvider, AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { InvalidGrantError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type {
    OAuthClientInformationFull,
    OAuthTokenRevocationRequest,
    OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';

/**
 * OAuth 2.1 for a single-owner server.
 *
 * Claude's connector UI speaks OAuth and nothing else — it has no field for a
 * static bearer token — so a personal server that wants to be reachable from
 * Claude has to implement the flow even though there is only ever one user.
 *
 * The consequence worth being explicit about: this server becomes reachable
 * from the public internet, and it runs arbitrary scrapers. The authorization
 * step therefore asks for a password rather than auto-approving. Auto-approval
 * would mean anyone who discovered the URL could complete the flow and mint
 * themselves a token.
 */

const DEFAULT_TOKEN_TTL_SECS = 30 * 24 * 3600;
const CODE_TTL_MS = 10 * 60 * 1000;

export interface AuthProviderOptions {
    /** Shared secret the owner types on the consent screen. */
    password: string;
    issuer: string;
    tokenTtlSecs?: number;
}

interface PendingAuthorization {
    client: OAuthClientInformationFull;
    params: AuthorizationParams;
    createdAt: number;
}

interface IssuedCode {
    clientId: string;
    codeChallenge: string;
    redirectUri: string;
    createdAt: number;
}

interface IssuedToken {
    clientId: string;
    expiresAt: number;
}

export interface AuthSnapshot {
    clients: OAuthClientInformationFull[];
    tokens: Array<{ token: string; clientId: string; expiresAt: number }>;
    refreshTokens: Array<{ token: string; clientId: string }>;
}

/** Constant-time comparison, so a wrong password cannot be found by timing. */
function secretsMatch(a: string, b: string): boolean {
    const left = Buffer.from(a);
    const right = Buffer.from(b);
    if (left.length !== right.length) return false;
    return timingSafeEqual(left, right);
}

export class OpenActorsAuthProvider implements OAuthServerProvider {
    private readonly clients = new Map<string, OAuthClientInformationFull>();
    private readonly pending = new Map<string, PendingAuthorization>();
    private readonly codes = new Map<string, IssuedCode>();
    private readonly tokens = new Map<string, IssuedToken>();
    private readonly refreshTokens = new Map<string, string>();

    constructor(private readonly options: AuthProviderOptions) {}

    get clientsStore(): OAuthRegisteredClientsStore {
        return {
            getClient: async (clientId) => this.clients.get(clientId),
            registerClient: async (client) => {
                // Dynamic registration hands over everything *except* the id:
                // minting that is the server's job, and a client supplying its
                // own could otherwise claim an existing one.
                const registered: OAuthClientInformationFull = {
                    ...client,
                    client_id: `oa-${randomUUID()}`,
                    client_id_issued_at: Math.floor(Date.now() / 1000),
                    // MCP clients are public clients that prove themselves with
                    // PKCE, not a shared secret. RFC 7591's default is
                    // client_secret_basic, and leaving it there makes the token
                    // endpoint reject every exchange with "client secret is
                    // required" — which is exactly what it did.
                    token_endpoint_auth_method: 'none',
                };
                delete (registered as { client_secret?: string }).client_secret;
                this.clients.set(registered.client_id, registered);
                return registered;
            },
        };
    }

    /** Registers a client with a known id. Used by tests and by restore-from-disk. */
    putClient(client: OAuthClientInformationFull): void {
        this.clients.set(client.client_id, client);
    }

    /** Records an in-flight authorization and returns the id the consent form posts back. */
    beginAuthorization(client: OAuthClientInformationFull, params: AuthorizationParams): string {
        const id = randomUUID();
        this.pending.set(id, { client, params, createdAt: Date.now() });
        return id;
    }

    getPending(id: string): PendingAuthorization | undefined {
        return this.pending.get(id);
    }

    /** Validates the owner's password and turns a pending authorization into a code. */
    approve(pendingId: string, password: string): string {
        const pending = this.pending.get(pendingId);
        if (!pending || Date.now() - pending.createdAt > CODE_TTL_MS) {
            this.pending.delete(pendingId);
            throw new Error('This authorization request is unknown or has expired. Start again from Claude.');
        }

        if (!secretsMatch(password, this.options.password)) {
            // The pending request is left in place so a typo can be retried;
            // it expires on its own.
            throw new Error('Incorrect password.');
        }

        this.pending.delete(pendingId);

        const code = randomUUID().replace(/-/g, '');
        this.codes.set(code, {
            clientId: pending.client.client_id,
            codeChallenge: pending.params.codeChallenge,
            redirectUri: pending.params.redirectUri,
            createdAt: Date.now(),
        });
        return code;
    }

    /** Renders the consent screen. The SDK router calls this for GET /authorize. */
    async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
        const pendingId = this.beginAuthorization(client, params);
        res.setHeader('content-type', 'text/html; charset=utf-8');
        res.end(consentPage(pendingId, client.client_name ?? client.client_id));
    }

    async challengeForAuthorizationCode(
        client: OAuthClientInformationFull,
        authorizationCode: string,
    ): Promise<string> {
        const issued = this.codes.get(authorizationCode);
        if (!issued || issued.clientId !== client.client_id) throw new InvalidGrantError('Invalid authorization code.');
        return issued.codeChallenge;
    }

    async exchangeAuthorizationCode(
        client: OAuthClientInformationFull,
        authorizationCode: string,
    ): Promise<OAuthTokens> {
        // These are protocol failures, not server faults. Thrown as plain
        // Errors the SDK reports them as HTTP 500, which tells a client
        // nothing it can act on; InvalidGrantError becomes 400 invalid_grant.
        const issued = this.codes.get(authorizationCode);
        if (!issued) throw new InvalidGrantError('Invalid or already-used authorization code.');
        if (issued.clientId !== client.client_id) {
            throw new InvalidGrantError('Authorization code was issued to another client.');
        }
        if (Date.now() - issued.createdAt > CODE_TTL_MS) {
            this.codes.delete(authorizationCode);
            throw new InvalidGrantError('Authorization code has expired.');
        }

        // Single use. A replayed code is the classic authorization-code attack.
        this.codes.delete(authorizationCode);
        return this.issueTokens(client.client_id);
    }

    async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string): Promise<OAuthTokens> {
        const clientId = this.refreshTokens.get(refreshToken);
        if (!clientId || clientId !== client.client_id) throw new InvalidGrantError('Invalid refresh token.');
        this.refreshTokens.delete(refreshToken);
        return this.issueTokens(client.client_id);
    }

    private issueTokens(clientId: string): OAuthTokens {
        const ttl = this.options.tokenTtlSecs ?? DEFAULT_TOKEN_TTL_SECS;
        const accessToken = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');
        const refreshToken = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');

        this.tokens.set(accessToken, { clientId, expiresAt: Date.now() + ttl * 1000 });
        this.refreshTokens.set(refreshToken, clientId);

        return { access_token: accessToken, token_type: 'Bearer', expires_in: ttl, refresh_token: refreshToken };
    }

    async verifyAccessToken(token: string): Promise<AuthInfo> {
        const issued = this.tokens.get(token);
        if (!issued) throw new InvalidTokenError('Invalid access token.');
        if (Date.now() > issued.expiresAt) {
            this.tokens.delete(token);
            throw new InvalidTokenError('Access token has expired.');
        }
        return { token, clientId: issued.clientId, scopes: [], expiresAt: Math.floor(issued.expiresAt / 1000) };
    }

    /**
     * A serializable view of what must survive a restart.
     *
     * Clients and tokens only. Authorization codes are single-use and expire
     * in minutes, so persisting them would extend the life of a credential
     * whose whole design is to be short-lived — and any code in flight during
     * a restart is one the client will simply retry.
     */
    snapshot(): AuthSnapshot {
        return {
            clients: [...this.clients.values()],
            tokens: [...this.tokens.entries()].map(([token, info]) => ({ token, ...info })),
            refreshTokens: [...this.refreshTokens.entries()].map(([token, clientId]) => ({ token, clientId })),
        };
    }

    restore(snapshot: AuthSnapshot | null | undefined): void {
        if (!snapshot) return;
        for (const client of snapshot.clients ?? []) this.clients.set(client.client_id, client);
        for (const entry of snapshot.tokens ?? []) {
            // Expired tokens are dropped on the way in rather than kept and
            // rejected later; there is no reason to reload dead credentials.
            if (entry.expiresAt > Date.now()) {
                this.tokens.set(entry.token, { clientId: entry.clientId, expiresAt: entry.expiresAt });
            }
        }
        for (const entry of snapshot.refreshTokens ?? []) this.refreshTokens.set(entry.token, entry.clientId);
    }

    async revokeToken(_client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
        this.tokens.delete(request.token);
        this.refreshTokens.delete(request.token);
    }
}

function consentPage(pendingId: string, clientName: string): string {
    const safe = clientName.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
    return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Authorize · openactors</title>
<style>
  :root { color-scheme: light dark }
  body { font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; display:grid; place-items:center;
         min-height:100vh; margin:0; background:Canvas; color:CanvasText }
  form { width:min(26rem,92vw); border:1px solid color-mix(in srgb, CanvasText 15%, transparent);
         border-radius:12px; padding:1.6rem }
  h1 { font-size:1.05rem; margin:0 0 .3rem }
  p { color:color-mix(in srgb, CanvasText 65%, transparent); margin:.2rem 0 1rem; font-size:.9rem }
  input { width:100%; padding:.55rem .7rem; font:inherit; border-radius:8px;
          border:1px solid color-mix(in srgb, CanvasText 25%, transparent); background:Canvas; color:CanvasText }
  button { width:100%; margin-top:.8rem; padding:.6rem; font:inherit; font-weight:600; border:0;
           border-radius:8px; background:#2f6feb; color:#fff; cursor:pointer }
  .warn { font-size:.82rem; border-left:3px solid #d4a72c; padding-left:.7rem; margin-top:1.1rem }
</style>
<form method="POST" action="/oauth/approve">
  <h1>Authorize ${safe}</h1>
  <p>This will let it run scrapers on this machine and read their results.</p>
  <input type="hidden" name="pending" value="${pendingId}">
  <input type="password" name="password" placeholder="Server password" autofocus required autocomplete="current-password">
  <button type="submit">Authorize</button>
  <p class="warn">Only approve a request you started yourself, just now.</p>
</form>`;
}
