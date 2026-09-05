import type { IncomingMessage, ServerResponse } from 'node:http';
import { resolveActorName } from './aliases.js';
import { CONTENT_TYPES, EXPORT_FORMATS, exportItems, type ExportFormat } from './export.js';
import { ActorInputError, type Runtime } from './runtime.js';
import { ActorIndex } from './registry.js';
import { deleteSchedule, loadSchedules, saveSchedule, type Scheduler } from './schedules.js';
import { listStorages, openDataset, openKeyValueStore } from './storage.js';
import { loadTasks, runTask, saveTask, deleteTask } from './tasks.js';
import type { ActorManifest } from './types.js';

/**
 * A REST interface over the same Actors the MCP server exposes.
 *
 * Paths mirror Apify's (`/v2/acts`, `/v2/actor-runs`, `/v2/datasets`) including
 * its `~` separator for namespaced Actor ids — a `/` in an id would otherwise
 * be indistinguishable from a path separator, which is precisely why Apify
 * chose `~`. A client written against Apify's API needs its base URL changed
 * and little else.
 */

const MAX_BODY_BYTES = 1_000_000;

function json(res: ServerResponse, status: number, body: unknown): void {
    const text = JSON.stringify(body, null, 2);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(text);
}

function fail(res: ServerResponse, status: number, message: string, extra: Record<string, unknown> = {}): void {
    json(res, status, { error: { message, ...extra } });
}

async function readBody(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    let size = 0;

    for await (const chunk of req) {
        size += (chunk as Buffer).length;
        // Refused rather than truncated: a silently clipped body would parse
        // into a valid-looking but wrong input object.
        if (size > MAX_BODY_BYTES) throw new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`);
        chunks.push(chunk as Buffer);
    }

    if (chunks.length === 0) return {};
    const text = Buffer.concat(chunks).toString('utf8').trim();
    if (text === '') return {};

    try {
        return JSON.parse(text);
    } catch (err) {
        throw new Error(`request body is not valid JSON: ${(err as Error).message}`);
    }
}

function describeActor(actor: ActorManifest) {
    return {
        id: actor.name.replace(/\//g, '~'),
        name: actor.name,
        title: actor.title,
        description: actor.description,
        tags: actor.tags,
        runnable: !actor.gatedReason,
        ...(actor.gatedReason ? { gatedReason: actor.gatedReason } : {}),
    };
}

export function parseIntParam(value: string | null, fallback: number, min: number, max: number): number {
    // `Number(null)` is 0, not NaN, so an absent parameter used to sail past the
    // isFinite guard and clamp to `min` instead of `fallback`. That silently gave
    // every unspecified `limit` a value of 1 and every unspecified `timeout` five
    // seconds. Absent and empty are settled here, before the numeric parse.
    if (value === null || value.trim() === '') return fallback;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function csvParam(value: string | null): string[] | undefined {
    if (value === null || value.trim() === '') return undefined;
    return value.split(',').map((v) => v.trim()).filter(Boolean);
}

export interface RestDeps {
    runtime: Runtime;
    index: ActorIndex;
    scheduler?: Scheduler;
}

/**
 * Handles a REST request. Returns false when the path is not ours, so the
 * caller can fall through to the MCP endpoint.
 */
export async function handleRest(req: IncomingMessage, res: ServerResponse, deps: RestDeps): Promise<boolean> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    if (!path.startsWith('/v2/')) return false;

    const segments = path.split('/').filter(Boolean).slice(1); // drop "v2"
    const method = req.method ?? 'GET';
    const { runtime, index } = deps;

    const findActor = async (rawId: string): Promise<ActorManifest | undefined> => {
        await index.refresh();
        return index.find(rawId, resolveActorName);
    };

    try {
        // GET /v2/acts
        if (segments[0] === 'acts' && segments.length === 1 && method === 'GET') {
            const actors = await index.refresh();
            json(res, 200, { data: { total: actors.length, items: actors.map(describeActor) } });
            return true;
        }

        // GET /v2/acts/:actorId
        if (segments[0] === 'acts' && segments.length === 2 && method === 'GET') {
            const actor = await findActor(segments[1]);
            if (!actor) return fail(res, 404, `Actor "${segments[1]}" not found.`), true;
            json(res, 200, { data: { ...describeActor(actor), input: actor.input } });
            return true;
        }

        // POST /v2/acts/:actorId/runs
        if (segments[0] === 'acts' && segments[2] === 'runs' && segments.length === 3 && method === 'POST') {
            const actor = await findActor(segments[1]);
            if (!actor) return fail(res, 404, `Actor "${segments[1]}" not found.`), true;

            const input = (await readBody(req)) as Record<string, unknown>;
            const timeoutSecs = parseIntParam(url.searchParams.get('timeout'), 300, 5, 3600);
            const memoryMbytes = url.searchParams.has('memory')
                ? parseIntParam(url.searchParams.get('memory'), 2048, 128, 16384)
                : undefined;

            // waitForFinish=0 starts the run and returns immediately, matching
            // Apify's parameter of the same name.
            const waitSecs = url.searchParams.has('waitForFinish')
                ? parseIntParam(url.searchParams.get('waitForFinish'), 60, 0, 600)
                : 60;

            try {
                let record = await runtime.start(actor, input, { timeoutSecs, memoryMbytes, origin: 'API' });
                const settled = await runtime.waitFor(record.id, waitSecs * 1000);
                if (settled) record = settled;
                // 201: a run resource was created, whatever its outcome.
                json(res, 201, { data: record });
            } catch (err) {
                if (err instanceof ActorInputError) {
                    // 400 with the specific problems, so a caller can fix the
                    // request rather than guess at it.
                    return fail(res, 400, `Invalid input for "${actor.name}"`, { errors: err.errors }), true;
                }
                return fail(res, 409, (err as Error).message), true;
            }
            return true;
        }

        // GET /v2/actor-runs
        if (segments[0] === 'actor-runs' && segments.length === 1 && method === 'GET') {
            await runtime.load();
            const runs = runtime.listRuns(
                parseIntParam(url.searchParams.get('limit'), 50, 1, 500),
                url.searchParams.get('actor') ? resolveActorName(url.searchParams.get('actor')!) : undefined,
                (url.searchParams.get('status') as never) ?? undefined,
            );
            json(res, 200, { data: { total: runs.length, items: runs.map(({ log, ...rest }) => rest) } });
            return true;
        }

        // GET /v2/actor-runs/:runId
        if (segments[0] === 'actor-runs' && segments.length === 2 && method === 'GET') {
            await runtime.load();
            const record = runtime.getRun(segments[1]);
            if (!record) return fail(res, 404, `Run "${segments[1]}" not found.`), true;
            const { log, ...rest } = record;
            json(res, 200, { data: { ...rest, logLines: log.length } });
            return true;
        }

        // GET /v2/actor-runs/:runId/log
        if (segments[0] === 'actor-runs' && segments[2] === 'log' && method === 'GET') {
            await runtime.load();
            const record = runtime.getRun(segments[1]);
            if (!record) return fail(res, 404, `Run "${segments[1]}" not found.`), true;
            res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
            res.end(record.log.join('\n'));
            return true;
        }

        // POST /v2/actor-runs/:runId/abort
        if (segments[0] === 'actor-runs' && segments[2] === 'abort' && method === 'POST') {
            await runtime.load();
            const record = runtime.getRun(segments[1]);
            if (!record) return fail(res, 404, `Run "${segments[1]}" not found.`), true;
            const aborted = runtime.abort(segments[1]);
            json(res, aborted ? 200 : 409, {
                data: { id: record.id, status: record.status },
                ...(aborted ? {} : { message: `Run is ${record.status} and cannot be aborted.` }),
            });
            return true;
        }

        // POST /v2/actor-runs/:runId/resurrect
        if (segments[0] === 'actor-runs' && segments[2] === 'resurrect' && method === 'POST') {
            const timeoutSecs = url.searchParams.has('timeout')
                ? parseIntParam(url.searchParams.get('timeout'), 300, 5, 3600)
                : undefined;
            try {
                await index.refresh();
                const record = await runtime.resurrect(
                    segments[1],
                    (name) => index.find(name, resolveActorName),
                    timeoutSecs,
                );
                json(res, 201, { data: record });
            } catch (err) {
                return fail(res, 409, (err as Error).message), true;
            }
            return true;
        }

        // GET /v2/datasets/:datasetId/items
        if (segments[0] === 'datasets' && segments[2] === 'items' && method === 'GET') {
            const format = (url.searchParams.get('format') ?? 'json').toLowerCase() as ExportFormat;
            if (!EXPORT_FORMATS.includes(format)) {
                return fail(res, 400, `Unknown format "${format}". Supported: ${EXPORT_FORMATS.join(', ')}`), true;
            }

            let dataset;
            try {
                dataset = await openDataset(segments[1]);
            } catch {
                return fail(res, 404, `Dataset "${segments[1]}" not found.`), true;
            }

            const offset = parseIntParam(url.searchParams.get('offset'), 0, 0, Number.MAX_SAFE_INTEGER);
            const limit = parseIntParam(url.searchParams.get('limit'), 1000, 1, 100_000);
            const { items } = await dataset.getData({ offset, limit });

            const body = await exportItems(items as Record<string, unknown>[], format, {
                fields: csvParam(url.searchParams.get('fields')),
                omit: csvParam(url.searchParams.get('omit')),
                clean: url.searchParams.get('clean') === '1' || url.searchParams.get('skipHidden') === '1',
            });

            const headers: Record<string, string> = { 'content-type': CONTENT_TYPES[format] };
            if (url.searchParams.get('attachment') === '1') {
                headers['content-disposition'] = `attachment; filename="${segments[1]}.${format}"`;
            }
            res.writeHead(200, headers);
            res.end(body);
            return true;
        }

        // GET /v2/datasets
        if (segments[0] === 'datasets' && segments.length === 1 && method === 'GET') {
            const names = await listStorages('datasets');
            json(res, 200, { data: { total: names.length, items: names } });
            return true;
        }

        // GET /v2/key-value-stores
        if (segments[0] === 'key-value-stores' && segments.length === 1 && method === 'GET') {
            const names = await listStorages('key_value_stores');
            json(res, 200, { data: { total: names.length, items: names } });
            return true;
        }

        // GET /v2/request-queues
        if (segments[0] === 'request-queues' && segments.length === 1 && method === 'GET') {
            const names = await listStorages('request_queues');
            json(res, 200, { data: { total: names.length, items: names } });
            return true;
        }

        // PUT/DELETE /v2/key-value-stores/:storeId/records/:key
        if (segments[0] === 'key-value-stores' && segments[2] === 'records' && segments[3] && method !== 'GET') {
            const key = segments.slice(3).join('/');
            const store = await openKeyValueStore(segments[1]);

            if (method === 'PUT') {
                await store.setValue(key, await readBody(req));
                json(res, 200, { data: { storeId: segments[1], key, written: true } });
                return true;
            }
            if (method === 'DELETE') {
                // Crawlee deletes a record by writing null to it.
                await store.setValue(key, null);
                json(res, 200, { data: { storeId: segments[1], key, deleted: true } });
                return true;
            }
        }

        // GET /v2/datasets/:datasetId
        if (segments[0] === 'datasets' && segments.length === 2 && method === 'GET') {
            try {
                const dataset = await openDataset(segments[1]);
                const { total } = await dataset.getData({ limit: 1 });
                json(res, 200, { data: { id: segments[1], itemCount: total } });
            } catch {
                return fail(res, 404, `Dataset "${segments[1]}" not found.`), true;
            }
            return true;
        }

        // GET /v2/key-value-stores/:storeId/records/:key
        if (segments[0] === 'key-value-stores' && segments[2] === 'records' && segments[3] && method === 'GET') {
            try {
                const store = await openKeyValueStore(segments[1]);
                const value = await store.getValue(segments.slice(3).join('/'));
                if (value === null || value === undefined) {
                    return fail(res, 404, `Key "${segments.slice(3).join('/')}" not found.`), true;
                }
                json(res, 200, { data: value });
            } catch {
                return fail(res, 404, `Key-value store "${segments[1]}" not found.`), true;
            }
            return true;
        }

        // GET/POST/DELETE /v2/actor-tasks
        if (segments[0] === 'actor-tasks') {
            if (segments.length === 1 && method === 'GET') {
                json(res, 200, { data: { items: await loadTasks() } });
                return true;
            }
            if (segments.length === 1 && method === 'POST') {
                const task = (await readBody(req)) as Record<string, unknown>;
                try {
                    json(res, 201, { data: await saveTask(task) });
                } catch (err) {
                    return fail(res, 400, (err as Error).message), true;
                }
                return true;
            }
            if (segments.length === 2 && method === 'DELETE') {
                const removed = await deleteTask(segments[1]);
                if (!removed) return fail(res, 404, `Task "${segments[1]}" not found.`), true;
                json(res, 200, { data: { id: segments[1], deleted: true } });
                return true;
            }
            // POST /v2/actor-tasks/:taskId/runs
            if (segments[2] === 'runs' && method === 'POST') {
                const overrides = (await readBody(req)) as Record<string, unknown>;
                try {
                    await index.refresh();
                    const record = await runTask(segments[1], overrides, runtime, (name) =>
                        index.find(name, resolveActorName),
                    );
                    json(res, 201, { data: record });
                } catch (err) {
                    if (err instanceof ActorInputError) {
                        return fail(res, 400, err.message, { errors: err.errors }), true;
                    }
                    return fail(res, 404, (err as Error).message), true;
                }
                return true;
            }
        }

        // GET/POST /v2/schedules, DELETE /v2/schedules/:id, POST /v2/schedules/:id/run
        if (segments[0] === 'schedules') {
            if (segments.length === 1 && method === 'GET') {
                const schedules = await loadSchedules();
                json(res, 200, { data: { total: schedules.length, items: schedules } });
                return true;
            }
            if (segments.length === 1 && method === 'POST') {
                try {
                    json(res, 201, { data: await saveSchedule((await readBody(req)) as Record<string, unknown>) });
                } catch (err) {
                    return fail(res, 400, (err as Error).message), true;
                }
                return true;
            }
            if (segments.length === 2 && method === 'DELETE') {
                const removed = await deleteSchedule(segments[1]);
                if (!removed) return fail(res, 404, `Schedule "${segments[1]}" not found.`), true;
                json(res, 200, { data: { id: segments[1], deleted: true } });
                return true;
            }
            // Fire a schedule now, without waiting for its next slot.
            if (segments[2] === 'run' && method === 'POST') {
                const schedule = (await loadSchedules()).find((s) => s.id === segments[1]);
                if (!schedule) return fail(res, 404, `Schedule "${segments[1]}" not found.`), true;

                const manifest = schedule.actor ? await findActor(schedule.actor) : undefined;
                if (schedule.actor && !manifest) {
                    return fail(res, 409, `Actor "${schedule.actor}" is not installed.`), true;
                }
                try {
                    const record = schedule.task
                        ? await runTask(schedule.task, schedule.input ?? {}, runtime, (name) =>
                              index.find(name, resolveActorName),
                          )
                        : await runtime.call(manifest!, schedule.input ?? {}, { origin: 'SCHEDULER' });
                    json(res, 201, { data: record });
                } catch (err) {
                    return fail(res, 409, (err as Error).message), true;
                }
                return true;
            }
        }

        fail(res, 404, `No such endpoint: ${method} ${path}`);
        return true;
    } catch (err) {
        fail(res, 400, (err as Error).message);
        return true;
    }
}
