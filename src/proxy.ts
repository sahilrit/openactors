import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PROJECT_ROOT } from './paths.js';

/**
 * Proxy management, modelled on Apify's ProxyConfiguration.
 *
 * What this is not: a supply of IPs. Residential addresses are rented from a
 * provider; no amount of code produces them. What this is, is the half of
 * Apify Proxy that is software — session stickiness, rotation, country
 * targeting and ban handling — with the provider left pluggable.
 *
 * The provider interface is a username template rather than a hardcoded format
 * because every vendor encodes the same three parameters differently:
 *
 *   Apify        groups-RESIDENTIAL,session-{session},country-{country}
 *   IPRoyal      user-country-{country}-session-{session}
 *   Oxylabs      customer-USER-cc-{country}-sessid-{session}
 *   DataImpulse  user__cr.{country};sid.{session}
 *
 * A template covers all of them and anything else, which matters more than
 * matching one vendor exactly.
 */

export interface ProxyPreset {
    host: string;
    port: number;
    username: string;
}

/** Ready-made templates, so a common provider needs only a password. */
export const PRESETS: Record<string, ProxyPreset> = {
    apify: { host: 'proxy.apify.com', port: 8000, username: 'groups-RESIDENTIAL,session-{session},country-{country}' },
    iproyal: { host: 'geo.iproyal.com', port: 12321, username: '{user}-country-{country}-session-{session}' },
    oxylabs: { host: 'pr.oxylabs.io', port: 7777, username: 'customer-{user}-cc-{country}-sessid-{session}' },
    dataimpulse: { host: 'gw.dataimpulse.com', port: 823, username: '{user}__cr.{country};sid.{session}' },
    evomi: { host: 'core-residential.evomi.com', port: 1000, username: '{user}-country-{country}-session-{session}' },
};

export interface ProxyConfig {
    /** `gateway` builds a URL per session; `list` rotates a supplied set. */
    mode?: 'gateway' | 'list';
    preset?: keyof typeof PRESETS | string;
    host?: string;
    port?: number;
    /** Username template. `{session}`, `{country}` and `{user}` are substituted. */
    username?: string;
    /** Account name substituted for `{user}` in the template. */
    user?: string;
    password?: string;
    country?: string;
    /** Fixed proxy URLs for `list` mode. */
    proxyUrls?: string[];
    /**
     * How long a session keeps its IP. Residential pools recycle addresses on
     * roughly this cadence, so holding one longer just means requests silently
     * come from somewhere new.
     */
    sessionTtlSecs?: number;
}

export interface ProxyInfo {
    url: string;
    sessionId: string;
    hostname: string;
    port: number;
    username?: string;
    country?: string;
}

const DEFAULT_TTL_SECS = 1800; // residential pools rotate at roughly 30 minutes

interface SessionEntry {
    info: ProxyInfo;
    createdAt: number;
    /** Consecutive blocks seen on this session. */
    strikes: number;
}

/** Session ids go in a username; keep them to the characters providers accept. */
function safeSessionId(raw: string): string {
    const cleaned = raw.replace(/[^A-Za-z0-9._~]/g, '_').slice(0, 50);
    return cleaned === '' ? 'default' : cleaned;
}

export class ProxyConfiguration {
    private readonly sessions = new Map<string, SessionEntry>();
    private cursor = 0;

    constructor(private readonly config: ProxyConfig) {}

    get enabled(): boolean {
        return this.config.mode === 'list'
            ? (this.config.proxyUrls?.length ?? 0) > 0
            : Boolean(this.config.host && this.config.port);
    }

    private buildUsername(sessionId: string): string | undefined {
        const template = this.config.username;
        if (!template) return this.config.user;

        return template
            .replace(/\{session\}/g, sessionId)
            .replace(/\{country\}/g, this.config.country ?? '')
            .replace(/\{user\}/g, this.config.user ?? '')
            // A provider template with an unused placeholder would otherwise
            // leave stray separators that break authentication.
            .replace(/-{2,}/g, '-')
            .replace(/[-,;._]+$/g, '');
    }

    private gatewayInfo(sessionId: string): ProxyInfo {
        const { host, port, password, country } = this.config;
        const username = this.buildUsername(sessionId);

        const auth = username
            ? `${encodeURIComponent(username)}:${encodeURIComponent(password ?? '')}@`
            : password
              ? `:${encodeURIComponent(password)}@`
              : '';

        return {
            url: `http://${auth}${host}:${port}`,
            sessionId,
            hostname: host!,
            port: port!,
            username,
            country,
        };
    }

    private listInfo(sessionId: string): ProxyInfo {
        const urls = this.config.proxyUrls ?? [];
        // Round-robin, so a fresh session takes the next address rather than
        // every session piling onto the first.
        const url = urls[this.cursor++ % urls.length];
        const parsed = new URL(url);
        return {
            url,
            sessionId,
            hostname: parsed.hostname,
            port: Number(parsed.port || 80),
            username: parsed.username || undefined,
            country: this.config.country,
        };
    }

    /**
     * Returns proxy details for a session, creating one if needed.
     *
     * The same session id always yields the same address until it expires or is
     * retired — which is the point. A crawl that changes IP between pages looks
     * less like a person than one that does not.
     */
    newProxyInfo(rawSessionId = 'default'): ProxyInfo | null {
        if (!this.enabled) return null;

        const sessionId = safeSessionId(rawSessionId);
        const ttlMs = (this.config.sessionTtlSecs ?? DEFAULT_TTL_SECS) * 1000;
        const existing = this.sessions.get(sessionId);

        if (existing && Date.now() - existing.createdAt < ttlMs) return existing.info;

        const info = this.config.mode === 'list' ? this.listInfo(sessionId) : this.gatewayInfo(sessionId);
        this.sessions.set(sessionId, { info, createdAt: Date.now(), strikes: 0 });
        return info;
    }

    newUrl(sessionId = 'default'): string | null {
        return this.newProxyInfo(sessionId)?.url ?? null;
    }

    /**
     * Records that a session was blocked. Retires it after two strikes so a
     * single 429 does not throw away a working address, but a genuinely burnt
     * one is not used again.
     */
    markBad(rawSessionId = 'default'): boolean {
        const sessionId = safeSessionId(rawSessionId);
        const entry = this.sessions.get(sessionId);
        if (!entry) return false;

        entry.strikes++;
        if (entry.strikes < 2) return false;

        this.sessions.delete(sessionId);
        return true;
    }

    /** Discards a session's address immediately. */
    retire(rawSessionId = 'default'): void {
        this.sessions.delete(safeSessionId(rawSessionId));
    }

    /** Live sessions, for diagnostics. */
    stats(): { sessions: number; mode: string; country?: string } {
        return {
            sessions: this.sessions.size,
            mode: this.config.mode ?? 'gateway',
            country: this.config.country,
        };
    }
}

/**
 * Loads proxy configuration.
 *
 * Precedence runs from most specific to least: an explicit config file, then
 * environment variables, then the single PROXY_URL that predates this and must
 * keep working.
 */
export async function loadProxyConfig(): Promise<ProxyConfig | null> {
    const file = resolve(PROJECT_ROOT, 'proxy.json');
    try {
        const parsed = JSON.parse(await readFile(file, 'utf8')) as ProxyConfig;
        return applyPreset(parsed);
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
            console.error(`[proxy] could not read ${file}: ${(err as Error).message}`);
        }
    }

    if (process.env.PROXY_HOST && process.env.PROXY_PORT) {
        return applyPreset({
            mode: 'gateway',
            preset: process.env.PROXY_PRESET,
            host: process.env.PROXY_HOST,
            port: Number(process.env.PROXY_PORT),
            username: process.env.PROXY_USERNAME_TEMPLATE,
            user: process.env.PROXY_USER,
            password: process.env.PROXY_PASSWORD,
            country: process.env.PROXY_COUNTRY,
        });
    }

    if (process.env.PROXY_PRESET && process.env.PROXY_PASSWORD) {
        return applyPreset({
            mode: 'gateway',
            preset: process.env.PROXY_PRESET,
            user: process.env.PROXY_USER,
            password: process.env.PROXY_PASSWORD,
            country: process.env.PROXY_COUNTRY,
        });
    }

    // The original single-URL form: still the simplest thing that works.
    if (process.env.PROXY_URL) {
        return { mode: 'list', proxyUrls: [process.env.PROXY_URL] };
    }

    return null;
}

/** Fills host/port/username from a named preset, without overriding explicit values. */
export function applyPreset(config: ProxyConfig): ProxyConfig {
    const preset = config.preset ? PRESETS[config.preset] : undefined;
    if (!preset) return config;

    return {
        ...config,
        host: config.host ?? preset.host,
        port: config.port ?? preset.port,
        username: config.username ?? preset.username,
    };
}

let shared: ProxyConfiguration | null | undefined;

/** The process-wide configuration, loaded once. */
export async function getProxyConfiguration(): Promise<ProxyConfiguration | null> {
    if (shared !== undefined) return shared;
    const config = await loadProxyConfig();
    shared = config ? new ProxyConfiguration(config) : null;
    return shared;
}

/** Forgets the loaded configuration, so an edited proxy.json applies without a restart. */
export function invalidateProxyConfiguration(): void {
    shared = undefined;
}
