// undici's own fetch, not the global one. Node bundles a different undici
// build internally, and handing the standalone package's ProxyAgent to the
// global fetch fails with "invalid onRequestStart method" — the two versions
// disagree about the dispatcher interface. Using one library for both sides
// removes the mismatch entirely.
import { ProxyAgent, fetch as undiciFetch } from 'undici';
import { chromium, type Browser } from 'playwright';
import { HeaderGenerator } from 'header-generator';
import { getProxyConfiguration, type ProxyInfo } from './proxy.js';

/**
 * Generates complete, internally consistent browser header sets.
 *
 * A hand-written User-Agent is the classic tell: it claims a Chrome version
 * while the accompanying sec-ch-ua, Accept and Accept-Language headers either
 * disagree with it or are missing entirely. This is Apify's own generator, and
 * it produces header sets that actually match a real browser build.
 */
const headerGenerator = new HeaderGenerator({
    browsers: ['chrome', 'firefox'],
    devices: ['desktop'],
    operatingSystems: ['macos', 'windows'],
});

/** A stable identity for one logical session, so headers do not change mid-crawl. */
const sessionHeaders = new Map<string, Record<string, string>>();

export function headersFor(session = 'default'): Record<string, string> {
    const existing = sessionHeaders.get(session);
    if (existing) return existing;

    let generated: Record<string, string>;
    try {
        generated = headerGenerator.getHeaders() as Record<string, string>;
    } catch {
        // Never let header generation be the thing that fails a fetch.
        generated = {
            'user-agent':
                'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'accept-language': 'en-US,en;q=0.9',
        };
    }

    sessionHeaders.set(session, generated);
    return generated;
}

/** Discards a session's identity, so the next request looks like a new visitor. */
export function rotateSession(session = 'default'): void {
    sessionHeaders.delete(session);
}

/**
 * Kept for the simplest case and for anything still reading it. Richer setups
 * come from proxy.json or the PROXY_* variables; see src/proxy.ts.
 */
export const PROXY_URL = process.env.PROXY_URL ?? null;

/**
 * One dispatcher per distinct proxy URL.
 *
 * Building a ProxyAgent per request would open a fresh connection pool every
 * time, which is slow and — because a new TLS handshake per request is itself
 * anomalous — counterproductive for the thing proxies are used to avoid.
 */
const agents = new Map<string, ProxyAgent>();

function agentFor(url: string): ProxyAgent {
    const existing = agents.get(url);
    if (existing) return existing;
    const agent = new ProxyAgent(url);
    agents.set(url, agent);
    return agent;
}

/** Resolves the proxy for a session, or null when none is configured. */
export async function proxyForSession(session: string): Promise<ProxyInfo | null> {
    const configuration = await getProxyConfiguration();
    return configuration?.newProxyInfo(session) ?? null;
}

/**
 * Records that a session was blocked, so its address can be retired.
 *
 * Header identity and IP are retired together on purpose: a request that
 * returns from a new address wearing the same browser fingerprint, or the
 * reverse, is more distinctive than either change alone.
 */
export async function markSessionBlocked(session = 'default'): Promise<void> {
    rotateSession(session);
    const configuration = await getProxyConfiguration();
    configuration?.markBad(session);
}

/** Serializes requests per host with a minimum gap between them. */
export class RateLimiter {
    private readonly last = new Map<string, number>();
    private readonly chain = new Map<string, Promise<void>>();

    constructor(private readonly minGapMs: number) {}

    /** Resolves when it is this host's turn, honouring the configured gap. */
    async take(host: string): Promise<void> {
        const previous = this.chain.get(host) ?? Promise.resolve();
        const next = previous.then(async () => {
            const since = Date.now() - (this.last.get(host) ?? 0);
            const wait = this.minGapMs - since;
            if (wait > 0) await new Promise((r) => setTimeout(r, wait));
            this.last.set(host, Date.now());
        });
        this.chain.set(host, next);
        return next;
    }
}

export interface FetchOptions {
    signal?: AbortSignal;
    timeoutMs?: number;
    retries?: number;
    headers?: Record<string, string>;
    /**
     * Requests sharing a session share one generated browser identity. Rotating
     * headers on every request within a crawl is itself anomalous — a real
     * visitor does not change browser between pages.
     */
    session?: string;
}

/**
 * Fetches text with bounded retries and exponential backoff.
 *
 * Only transient conditions are retried — network errors, 429, and 5xx. A 404
 * or 403 is a settled answer, and retrying it wastes time and makes a blocked
 * client look more like a bot, not less.
 */
export async function fetchText(url: string, options: FetchOptions = {}): Promise<{ status: number; body: string }> {
    const { signal, timeoutMs = 25_000, retries = 2, headers = {}, session = 'default' } = options;
    let lastError = '';

    for (let attempt = 0; attempt <= retries; attempt++) {
        if (attempt > 0) {
            const backoff = 500 * 2 ** (attempt - 1);
            await new Promise((r) => setTimeout(r, backoff));
        }

        try {
            const proxy = await proxyForSession(session);
            const res = await undiciFetch(url, {
                signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
                headers: { ...headersFor(session), ...headers },
                ...(proxy ? { dispatcher: agentFor(proxy.url) } : {}),
            });

            const retryable = res.status === 429 || res.status >= 500;
            if (!res.ok && retryable && attempt < retries) {
                lastError = `HTTP ${res.status}`;
                // A 429 or 403 means this identity is the problem, so retrying
                // unchanged just repeats the request that failed.
                if (res.status === 429 || res.status === 403) await markSessionBlocked(session);
                continue;
            }
            // A block that is not retried still counts against the session, so
            // the next caller does not inherit a burnt address.
            if (res.status === 403 || res.status === 429) await markSessionBlocked(session);
            return { status: res.status, body: await res.text() };
        } catch (err) {
            // Node's fetch reports a bare "fetch failed" and puts the real
            // reason — DNS, refused connection, TLS, proxy failure — in
            // `cause`. Without unwrapping it, every network problem looks the
            // same in a log.
            const error = err as Error & { cause?: Error };
            lastError = error.cause?.message ? `${error.message}: ${error.cause.message}` : error.message;
            if (signal?.aborted) throw err;
        }
    }

    throw new Error(`fetch failed after ${retries + 1} attempt(s): ${lastError}`);
}

/**
 * Launches a browser for Actors that need one.
 *
 * Prefers the system Chrome install. Playwright's bundled Chromium does not
 * support macOS 12, which is what this runs on — driving the installed Chrome
 * is the supported path there, and it falls back to bundled Chromium elsewhere.
 */
export async function launchBrowser(session = 'default'): Promise<Browser> {
    const proxy = await proxyForSession(session);

    // Playwright wants credentials separately from the server address, unlike
    // undici which takes them inline.
    let proxyOption: { server: string; username?: string; password?: string } | undefined;
    if (proxy) {
        const parsed = new URL(proxy.url);
        proxyOption = {
            server: `${parsed.protocol}//${parsed.host}`,
            ...(parsed.username ? { username: decodeURIComponent(parsed.username) } : {}),
            ...(parsed.password ? { password: decodeURIComponent(parsed.password) } : {}),
        };
    }

    const launchOptions = {
        headless: true,
        ...(proxyOption ? { proxy: proxyOption } : {}),
    };

    try {
        return await chromium.launch({ ...launchOptions, channel: 'chrome' });
    } catch (chromeError) {
        try {
            return await chromium.launch(launchOptions);
        } catch {
            throw new Error(
                'Could not launch a browser. Install Google Chrome, or run ' +
                    `\`npx playwright install chromium\` if your OS supports it. (${(chromeError as Error).message.split('\n')[0]})`,
            );
        }
    }
}
