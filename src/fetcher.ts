import { ProxyAgent } from 'undici';
import { chromium, type Browser } from 'playwright';
import { HeaderGenerator } from 'header-generator';

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
 * The single place a proxy is configured. Everything here works from your own
 * IP by default, which is free; targets that fingerprint hard (Google Maps at
 * volume, LinkedIn) need rotating residential addresses, and that must be a
 * config change rather than a rewrite of every Actor.
 *
 * Set PROXY_URL=http://user:pass@host:port to route both HTTP and browser
 * traffic through a proxy.
 */
export const PROXY_URL = process.env.PROXY_URL ?? null;

const proxyAgent = PROXY_URL ? new ProxyAgent(PROXY_URL) : null;

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
            const res = await fetch(url, {
                signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
                headers: { ...headersFor(session), ...headers },
                ...(proxyAgent ? ({ dispatcher: proxyAgent } as Record<string, unknown>) : {}),
            });

            const retryable = res.status === 429 || res.status >= 500;
            if (!res.ok && retryable && attempt < retries) {
                lastError = `HTTP ${res.status}`;
                // A 429 or 403 means this identity is the problem, so retrying
                // with the same headers repeats the request that just failed.
                if (res.status === 429 || res.status === 403) rotateSession(session);
                continue;
            }
            return { status: res.status, body: await res.text() };
        } catch (err) {
            lastError = (err as Error).message;
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
export async function launchBrowser(): Promise<Browser> {
    const launchOptions = {
        headless: true,
        ...(PROXY_URL ? { proxy: { server: PROXY_URL } } : {}),
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
