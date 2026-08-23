import type { IncomingMessage, ServerResponse } from 'node:http';
import express, { type Express } from 'express';
import { authorizationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/authorize.js';
import { clientRegistrationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/register.js';
import { revocationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/revoke.js';
import { tokenHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/token.js';
import type { OpenActorsAuthProvider } from './oauth.js';

/**
 * The HTTP surface of the OAuth flow.
 *
 * The SDK's `mcpAuthRouter` bundles the endpoints and the discovery documents
 * together under one mount point, but the two cannot share one: `.well-known`
 * paths are fixed at the root by RFC 8414 and RFC 9728, while the endpoints
 * belong under a prefix. So the individual handlers are composed here instead.
 *
 * The base URL is resolved per request rather than fixed at construction: a
 * tunnel hands out a different hostname every time it starts, and metadata
 * advertising yesterday's hostname fails discovery in a way that looks like a
 * client bug.
 */
export function createOAuthHandler(
    provider: OpenActorsAuthProvider,
    getBaseUrl: () => string,
): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
    const apps = new Map<string, Express>();

    const appFor = (base: string): Express => {
        const existing = apps.get(base);
        if (existing) return existing;

        const app = express();

        app.use('/oauth/authorize', authorizationHandler({ provider }));
        app.use('/oauth/token', tokenHandler({ provider }));
        app.use('/oauth/register', clientRegistrationHandler({ clientsStore: provider.clientsStore }));
        app.use('/oauth/revoke', revocationHandler({ provider }));

        // Completes the consent screen. Not part of the OAuth spec — it is the
        // step that proves the person approving is the server's owner.
        app.post('/oauth/approve', express.urlencoded({ extended: false }), (req, res) => {
            const { pending, password } = req.body as { pending?: string; password?: string };
            const request = pending ? provider.getPending(pending) : undefined;

            try {
                const code = provider.approve(String(pending ?? ''), String(password ?? ''));
                const redirect = new URL(request!.params.redirectUri);
                redirect.searchParams.set('code', code);
                // State must round-trip or the client treats the callback as forged.
                if (request!.params.state) redirect.searchParams.set('state', request!.params.state);
                res.redirect(302, redirect.toString());
            } catch (err) {
                res.status(401).type('html').send(
                    `<!doctype html><meta charset="utf-8"><title>Not authorized</title>
                     <p style="font:15px sans-serif;padding:2rem">${(err as Error).message}
                     <br><br><a href="javascript:history.back()">Go back</a></p>`,
                );
            }
        });

        apps.set(base, app);
        return app;
    };

    /**
     * Discovery documents, served without Express.
     *
     * Express 5 does not match a route path beginning with a dot, so
     * `app.get('/.well-known/…')` never fires — it 404s while a sibling route
     * works. These are two static JSON documents; serving them directly is
     * both simpler than fighting the router and immune to the next change in
     * its path matching.
     */
    const metadataFor = (path: string, base: string): object | null => {
        if (path === '/.well-known/oauth-authorization-server') {
            return {
                issuer: base,
                authorization_endpoint: `${base}/oauth/authorize`,
                token_endpoint: `${base}/oauth/token`,
                registration_endpoint: `${base}/oauth/register`,
                revocation_endpoint: `${base}/oauth/revoke`,
                response_types_supported: ['code'],
                grant_types_supported: ['authorization_code', 'refresh_token'],
                // Claude uses authorization code with PKCE. S256 is the only
                // method worth advertising; "plain" defeats the purpose.
                code_challenge_methods_supported: ['S256'],
                // Only 'none': this server issues public clients that use PKCE.
                token_endpoint_auth_methods_supported: ['none'],
            };
        }
        // RFC 9728: tells a client which authorization server guards this resource.
        if (path === '/.well-known/oauth-protected-resource') {
            return { resource: `${base}/mcp`, authorization_servers: [base], resource_name: 'openactors' };
        }
        return null;
    };

    const OAUTH_PATHS = ['/.well-known/oauth-', '/oauth/'];

    return async (req, res) => {
        const path = (req.url ?? '/').split('?')[0];
        if (!OAUTH_PATHS.some((prefix) => path.startsWith(prefix))) return false;

        const metadata = metadataFor(path, getBaseUrl());
        if (metadata) {
            res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
            res.end(JSON.stringify(metadata, null, 2));
            return true;
        }

        await new Promise<void>((resolve) => {
            res.on('close', resolve);
            res.on('finish', resolve);
            appFor(getBaseUrl())(req as never, res as never);
        });
        return true;
    };
}
