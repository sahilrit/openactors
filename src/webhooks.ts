import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PROJECT_ROOT } from './paths.js';
import type { RunRecord } from './types.js';

/** Event names match Apify's, so an existing consumer needs no changes. */
export const RUN_EVENTS = [
    'ACTOR.RUN.CREATED',
    'ACTOR.RUN.SUCCEEDED',
    'ACTOR.RUN.FAILED',
    'ACTOR.RUN.ABORTED',
    'ACTOR.RUN.TIMED_OUT',
    'ACTOR.RUN.RESURRECTED',
] as const;

export type RunEvent = (typeof RUN_EVENTS)[number];

export interface WebhookConfig {
    url: string;
    /** Events to deliver. Omitted means every run event. */
    events?: RunEvent[];
    /** Actor ids to deliver for. Omitted means every Actor. */
    actors?: string[];
    headers?: Record<string, string>;
}

interface WebhookFile {
    webhooks: WebhookConfig[];
}

const DELIVERY_TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 3;

let cached: WebhookConfig[] | null = null;

/** Forgets the loaded config, so an edited webhooks.json applies without a restart. */
export function invalidateWebhookConfig(): void {
    cached = null;
}

export async function loadWebhooks(): Promise<WebhookConfig[]> {
    if (cached) return cached;

    const configured: WebhookConfig[] = [];

    // A single URL in the environment covers the common case without a file.
    if (process.env.WEBHOOK_URL) {
        configured.push({ url: process.env.WEBHOOK_URL });
    }

    const file = resolve(PROJECT_ROOT, 'webhooks.json');
    try {
        const parsed = JSON.parse(await readFile(file, 'utf8')) as WebhookFile;
        for (const hook of parsed.webhooks ?? []) {
            if (typeof hook?.url === 'string' && /^https?:\/\//.test(hook.url)) configured.push(hook);
            else console.error(`[webhooks] ignoring an entry with no valid url: ${JSON.stringify(hook)}`);
        }
    } catch (err) {
        // Absent is the normal case. Malformed is worth saying out loud, since
        // the alternative is silently delivering nothing.
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
            console.error(`[webhooks] could not read ${file}: ${(err as Error).message}`);
        }
    }

    cached = configured;
    return configured;
}

export function payloadFor(event: RunEvent, record: RunRecord) {
    return {
        eventType: event,
        createdAt: new Date().toISOString(),
        // Apify's field names, so a consumer written against it still works.
        actorId: record.actorName,
        actorRunId: record.id,
        resource: {
            id: record.id,
            actId: record.actorName,
            status: record.status,
            startedAt: record.startedAt,
            finishedAt: record.finishedAt ?? null,
            durationMs: record.durationMs ?? null,
            defaultDatasetId: record.defaultDatasetId,
            itemCount: record.itemCount,
            errorMessage: record.errorMessage ?? null,
            origin: record.origin ?? null,
            resurrectedFrom: record.resurrectedFrom ?? null,
        },
    };
}

async function deliver(hook: WebhookConfig, body: string): Promise<void> {
    let lastError = '';

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        if (attempt > 1) await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 2)));

        try {
            const res = await fetch(hook.url, {
                method: 'POST',
                headers: { 'content-type': 'application/json', ...(hook.headers ?? {}) },
                body,
                signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
            });
            if (res.ok) return;

            // 4xx other than 429 is a settled rejection: the receiver
            // understood and refused, and repeating will not change that.
            if (res.status >= 400 && res.status < 500 && res.status !== 429) {
                throw new Error(`${hook.url} rejected the delivery with HTTP ${res.status}`);
            }
            lastError = `HTTP ${res.status}`;
        } catch (err) {
            if ((err as Error).message.includes('rejected the delivery')) throw err;
            lastError = (err as Error).message;
        }
    }

    throw new Error(`${hook.url} failed after ${MAX_ATTEMPTS} attempts: ${lastError}`);
}

/**
 * Delivers one run event to every matching webhook.
 *
 * Deliveries run concurrently and failures are collected rather than thrown one
 * at a time, so a single dead endpoint cannot stop the others from receiving.
 */
export async function emitRunEvent(event: RunEvent, record: RunRecord): Promise<void> {
    const hooks = (await loadWebhooks()).filter(
        (hook) =>
            (hook.events === undefined || hook.events.includes(event)) &&
            (hook.actors === undefined || hook.actors.includes(record.actorName)),
    );
    if (hooks.length === 0) return;

    const body = JSON.stringify(payloadFor(event, record));
    const results = await Promise.allSettled(hooks.map((hook) => deliver(hook, body)));

    const failures = results
        .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
        .map((r) => (r.reason as Error).message);

    if (failures.length > 0) throw new Error(failures.join('; '));
}
