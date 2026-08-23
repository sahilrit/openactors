import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { connect } from 'node:net';
import { ProxyConfiguration, applyPreset, PRESETS } from '../src/proxy.js';
import { fetchText, markSessionBlocked } from '../src/fetcher.js';
import { invalidateProxyConfiguration } from '../src/proxy.js';

describe('session stickiness', () => {
    const config = () =>
        new ProxyConfiguration({ mode: 'gateway', host: 'gw.test', port: 7000, username: 'u-session-{session}', password: 'p' });

    it('returns the same address for the same session', () => {
        const proxies = config();
        expect(proxies.newUrl('run-1')).toBe(proxies.newUrl('run-1'));
    });

    it('gives different sessions different credentials', () => {
        const proxies = config();
        expect(proxies.newUrl('run-1')).not.toBe(proxies.newUrl('run-2'));
    });

    it('embeds the session id in the username, which is how providers route it', () => {
        // Hyphens become underscores: Apify's session ids permit only
        // alphanumerics, dots, underscores and tildes, and that set is the
        // intersection across providers, so being strict is the safe default.
        expect(config().newUrl('run-1')).toContain('u-session-run_1');
    });

    it('expires a session after its ttl, since the pool recycles addresses anyway', async () => {
        const proxies = new ProxyConfiguration({
            mode: 'gateway', host: 'gw.test', port: 7000, username: 'u-session-{session}', sessionTtlSecs: 0,
        });
        const first = proxies.newProxyInfo('s');
        await new Promise((r) => setTimeout(r, 5));
        expect(proxies.stats().sessions).toBe(1);
        expect(proxies.newProxyInfo('s')).not.toBe(first);
    });

    it('sanitises a session id to characters providers accept', () => {
        const url = config().newUrl('run/with spaces:and!punctuation');
        expect(url).toContain('run_with_spaces_and_punctuation');
    });
});

describe('rotation and bans', () => {
    it('round-robins a supplied list', () => {
        const proxies = new ProxyConfiguration({
            mode: 'list',
            proxyUrls: ['http://a.test:1', 'http://b.test:2', 'http://c.test:3'],
        });
        expect([proxies.newUrl('s1'), proxies.newUrl('s2'), proxies.newUrl('s3')]).toEqual([
            'http://a.test:1',
            'http://b.test:2',
            'http://c.test:3',
        ]);
    });

    it('tolerates one block before retiring an address', () => {
        // A single 429 can be bad luck; throwing away a working address for it
        // wastes the pool faster than the blocks do.
        const proxies = new ProxyConfiguration({ mode: 'gateway', host: 'gw.test', port: 1, username: 's-{session}' });
        proxies.newUrl('s');
        expect(proxies.markBad('s')).toBe(false);
        expect(proxies.markBad('s')).toBe(true);
        expect(proxies.stats().sessions).toBe(0);
    });

    it('issues a new address after one is retired', () => {
        const proxies = new ProxyConfiguration({
            mode: 'list', proxyUrls: ['http://a.test:1', 'http://b.test:2'],
        });
        const first = proxies.newUrl('s');
        proxies.retire('s');
        expect(proxies.newUrl('s')).not.toBe(first);
    });

    it('reports itself disabled when nothing is configured', () => {
        expect(new ProxyConfiguration({ mode: 'list', proxyUrls: [] }).enabled).toBe(false);
        expect(new ProxyConfiguration({ mode: 'gateway' }).enabled).toBe(false);
        expect(new ProxyConfiguration({ mode: 'list', proxyUrls: [] }).newUrl('s')).toBeNull();
    });
});

describe('provider templates', () => {
    it('substitutes user, country and session', () => {
        const proxies = new ProxyConfiguration({
            mode: 'gateway', host: 'gw.test', port: 1,
            username: 'customer-{user}-cc-{country}-sessid-{session}', user: 'acme', country: 'US', password: 'p',
        });
        expect(decodeURIComponent(new URL(proxies.newUrl('abc')!).username)).toBe('customer-acme-cc-US-sessid-abc');
    });

    it('does not leave stray separators when a placeholder is empty', () => {
        const proxies = new ProxyConfiguration({
            mode: 'gateway', host: 'gw.test', port: 1, username: 'u-country-{country}-session-{session}', password: 'p',
        });
        // No country configured; the result must still authenticate.
        expect(decodeURIComponent(new URL(proxies.newUrl('abc')!).username)).toBe('u-country-session-abc');
    });

    it('escapes credentials so a password with @ or : cannot break the url', () => {
        const proxies = new ProxyConfiguration({
            mode: 'gateway', host: 'gw.test', port: 1, username: 'u', password: 'p@ss:word/1',
        });
        const url = new URL(proxies.newUrl('s')!);
        expect(url.hostname).toBe('gw.test');
        expect(decodeURIComponent(url.password)).toBe('p@ss:word/1');
    });

    it('fills host, port and template from a preset', () => {
        const config = applyPreset({ preset: 'apify', password: 'p' });
        expect(config.host).toBe(PRESETS.apify.host);
        expect(config.username).toContain('groups-RESIDENTIAL');
    });

    it('lets an explicit value override its preset', () => {
        expect(applyPreset({ preset: 'apify', host: 'mine.test' }).host).toBe('mine.test');
    });
});

/**
 * Proves the plumbing actually routes, rather than only that URLs are built
 * correctly. A local proxy stands in for a rented residential one: the code
 * path under test — undici dispatcher selection, credentials, connection reuse
 * — is identical regardless of who owns the exit IP.
 */
describe('routing through a real proxy', () => {
    let origin: Server;
    let proxy: Server;
    let originPort = 0;
    let proxyPort = 0;
    const seen: string[] = [];

    beforeAll(async () => {
        origin = createServer((_req, res) => {
            res.writeHead(200, { 'content-type': 'text/plain' });
            res.end('served-by-origin');
        });
        await new Promise<void>((r) => origin.listen(0, '127.0.0.1', r));
        originPort = (origin.address() as { port: number }).port;

        proxy = createServer((req, res) => {
            // An HTTP proxy receives the absolute URI rather than a path.
            seen.push(`${req.method} ${req.url} auth=${req.headers['proxy-authorization'] ? 'yes' : 'no'}`);
            const target = new URL(req.url!);
            const upstream = connect(Number(target.port), target.hostname, () => {
                upstream.write(`GET ${target.pathname} HTTP/1.1\r\nHost: ${target.host}\r\nConnection: close\r\n\r\n`);
            });
            let raw = '';
            upstream.on('data', (c) => (raw += c.toString()));
            upstream.on('end', () => {
                res.writeHead(200, { 'content-type': 'text/plain' });
                res.end(raw.split('\r\n\r\n').slice(1).join('\r\n\r\n'));
            });
            upstream.on('error', () => res.writeHead(502).end('bad gateway'));
        });
        await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
        proxyPort = (proxy.address() as { port: number }).port;

        process.env.PROXY_URL = `http://user:pass@127.0.0.1:${proxyPort}`;
        invalidateProxyConfiguration();
    });

    afterAll(async () => {
        delete process.env.PROXY_URL;
        invalidateProxyConfiguration();
        await new Promise<void>((r) => origin.close(() => r()));
        await new Promise<void>((r) => proxy.close(() => r()));
    });

    it('sends the request through the proxy and returns the origin body', async () => {
        const { status, body } = await fetchText(`http://127.0.0.1:${originPort}/hello`, { retries: 0 });
        expect(status).toBe(200);
        expect(body).toContain('served-by-origin');
        expect(seen.length).toBeGreaterThan(0);
        expect(seen[0]).toContain(`http://127.0.0.1:${originPort}/hello`);
    }, 20_000);

    it('presents proxy credentials', async () => {
        await fetchText(`http://127.0.0.1:${originPort}/creds`, { retries: 0 });
        expect(seen.some((entry) => entry.includes('auth=yes'))).toBe(true);
    }, 20_000);

    it('marking a session blocked does not throw when no gateway is configured', async () => {
        await expect(markSessionBlocked('some-session')).resolves.toBeUndefined();
    });
});
