/**
 * The whole OAuth dance against a running server, exactly as Claude performs
 * it: discover, register, consent, exchange with PKCE, then call a tool.
 *
 * Run: OAUTH_PASSWORD=… PORT=… npx tsx tests/oauth-e2e.ts <baseUrl> <password>
 */
import { createHash, randomBytes } from 'node:crypto';
import { Resolver } from 'node:dns';
import { Agent, setGlobalDispatcher } from 'undici';

/**
 * Some ISP resolvers return NXDOMAIN for trycloudflare.com subdomains. That is
 * a local resolution problem, not a tunnel problem — Claude reaches the tunnel
 * through its own DNS.
 *
 * dns.setServers alone does not help: it steers dns.resolve*, while fetch
 * resolves through getaddrinfo and the OS. Overriding the dispatcher's lookup
 * is what actually redirects the query.
 */
if (process.env.E2E_DNS) {
    const resolver = new Resolver();
    resolver.setServers(process.env.E2E_DNS.split(','));

    setGlobalDispatcher(
        new Agent({
            connect: {
                lookup(hostname, options, callback) {
                    resolver.resolve4(hostname, (err, addresses) => {
                        if (err || !addresses?.length) {
                            return callback(err ?? new Error(`no A record for ${hostname}`), '', 4);
                        }
                        // undici asks with { all: true } and expects an array;
                        // returning a bare string yields "Invalid IP address:
                        // undefined" from deep inside net.
                        if ((options as { all?: boolean }).all) {
                            return callback(null, addresses.map((address) => ({ address, family: 4 })) as never, 4);
                        }
                        callback(null, addresses[0], 4);
                    });
                },
            },
        }),
    );
}
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const base = process.argv[2] ?? 'http://127.0.0.1:8996';
const password = process.argv[3] ?? 'hunter2';

let failures = 0;
const check = (label: string, ok: boolean, detail = '') => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
    if (!ok) failures++;
};

const b64url = (buf: Buffer) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// 1. Discovery
const prm = await (await fetch(`${base}/.well-known/oauth-protected-resource`)).json();
const asMeta = await (await fetch(new URL('/.well-known/oauth-authorization-server', prm.authorization_servers[0]))).json();
check('discovery resolves the authorization server', asMeta.issuer === prm.authorization_servers[0]);

// 2. Dynamic registration
const reg = await (await fetch(asMeta.registration_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ redirect_uris: ['https://claude.ai/api/mcp/auth_callback'], client_name: 'e2e' }),
})).json();
check('client registered', typeof reg.client_id === 'string' && reg.client_id.length > 0);

// 3. Authorize with PKCE
const verifier = b64url(randomBytes(32));
const challenge = b64url(createHash('sha256').update(verifier).digest());
const authUrl = new URL(asMeta.authorization_endpoint);
authUrl.searchParams.set('client_id', reg.client_id);
authUrl.searchParams.set('redirect_uri', 'https://claude.ai/api/mcp/auth_callback');
authUrl.searchParams.set('response_type', 'code');
authUrl.searchParams.set('code_challenge', challenge);
authUrl.searchParams.set('code_challenge_method', 'S256');
authUrl.searchParams.set('state', 'e2e-state');

const consent = await (await fetch(authUrl)).text();
const pending = consent.match(/name="pending" value="([^"]+)"/)?.[1];
check('consent screen issued a pending id', Boolean(pending));

// 4. Wrong password must not produce a code
const refused = await fetch(`${base}/oauth/approve`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ pending: pending!, password: 'not-the-password' }).toString(),
    redirect: 'manual',
});
check('a wrong password is refused', refused.status === 401, `HTTP ${refused.status}`);

// 5. Correct password redirects with a code
const approved = await fetch(`${base}/oauth/approve`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ pending: pending!, password }).toString(),
    redirect: 'manual',
});
const location = new URL(approved.headers.get('location') ?? 'https://x.test');
const code = location.searchParams.get('code');
check('approval redirects with a code and the state', Boolean(code) && location.searchParams.get('state') === 'e2e-state');

// 6. Token exchange, with PKCE verification
const tokenRes = await fetch(asMeta.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: code!,
        redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
        client_id: reg.client_id,
        code_verifier: verifier,
    }).toString(),
});
const tokens = await tokenRes.json();
check('code exchanged for an access token', tokenRes.status === 200 && typeof tokens.access_token === 'string',
    tokenRes.status === 200 ? '' : JSON.stringify(tokens).slice(0, 120));

// 7. A wrong PKCE verifier must be rejected
const replay = await fetch(asMeta.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
        grant_type: 'authorization_code', code: code!, client_id: reg.client_id,
        redirect_uri: 'https://claude.ai/api/mcp/auth_callback', code_verifier: 'wrong-verifier',
    }).toString(),
});
const replayBody = await replay.json().catch(() => ({}));
// 400 invalid_grant, not 500: a replayed code is a protocol error the client
// should understand, and a server error tells it nothing useful.
check('a used code is refused as invalid_grant', replay.status === 400 && replayBody.error === 'invalid_grant',
    `HTTP ${replay.status} ${JSON.stringify(replayBody).slice(0, 80)}`);

// 8. The token actually works on /mcp
const client = new Client({ name: 'oauth-e2e', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${tokens.access_token}` } },
}));
const { tools } = await client.listTools();
check('the OAuth token authenticates an MCP session', tools.length > 0, `${tools.length} tools`);

const result: any = await client.callTool({
    name: 'call-actor',
    arguments: { actor: 'jobs/ats-boards', input: { boards: ['ashby:linear'], titleIncludes: ['engineer'] }, timeoutSecs: 120 },
});
const run = JSON.parse(result.content[0].text);
check('a real scrape runs over the OAuth session', run.status === 'SUCCEEDED' && run.itemCount > 0,
    `${run.status} ${run.itemCount} items`);
await client.close();

console.log(`\n${failures === 0 ? 'ALL PASSED' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
