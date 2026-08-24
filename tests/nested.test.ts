import { describe, expect, it } from 'vitest';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Runtime } from '../src/runtime.js';
import { configureStorage } from '../src/storage.js';
import type { ActorManifest } from '../src/types.js';

configureStorage();

const ACTORS = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'actors');

const manifest = (name: string): ActorManifest => ({
    name: `test/${name}`,
    title: name,
    description: '',
    tags: [],
    input: { type: 'object', properties: { n: { type: 'integer' } } },
    runtime: 'node',
    dir: join(ACTORS, name),
});

function runtimeWithFixtures(): Runtime {
    const runtime = new Runtime();
    runtime.resolveActor = (name) => {
        const short = name.replace(/^test\//, '');
        return ['ok', 'calls-other', 'crash-exit'].includes(short) ? manifest(short) : undefined;
    };
    return runtime;
}

describe('Actor calling Actor', () => {
    it('runs the nested Actor and returns its items', async () => {
        const runtime = runtimeWithFixtures();
        const record = await runtime.call(manifest('calls-other'), { n: 3 }, { timeoutSecs: 60 });

        expect(record.status).toBe('SUCCEEDED');
        expect(record.itemCount).toBe(3);
        expect(record.log.join(' ')).toMatch(/nested run SUCCEEDED with 3 item\(s\)/);
    }, 60_000);

    it('records the nested run in the caller\'s log', async () => {
        const runtime = runtimeWithFixtures();
        const record = await runtime.call(manifest('calls-other'), { n: 1 }, { timeoutSecs: 60 });
        expect(record.log.join(' ')).toMatch(/called test\/ok -> SUCCEEDED/);
    }, 60_000);

    it('does not deadlock when only one slot exists', async () => {
        // The caller holds the single slot while waiting for the nested run.
        // Without exempting nested runs from the limit this hangs until the
        // timeout — the deadlock this design has to avoid.
        const runtime = new Runtime(1);
        runtime.resolveActor = (name) =>
            ['test/ok', 'test/calls-other'].includes(name) ? manifest(name.replace('test/', '')) : undefined;

        const record = await runtime.call(manifest('calls-other'), { n: 2 }, { timeoutSecs: 45 });
        expect(record.status).toBe('SUCCEEDED');
        expect(runtime.capacity()).toMatchObject({ limit: 1, running: 0, queued: 0 });
    }, 60_000);

    it('reports a call to an Actor that does not exist', async () => {
        const runtime = runtimeWithFixtures();
        runtime.resolveActor = () => undefined;
        const record = await runtime.call(manifest('calls-other'), { n: 1 }, { timeoutSecs: 45 });
        expect(record.status).toBe('FAILED');
        expect(record.errorMessage).toMatch(/not found/);
    }, 60_000);

    it('surfaces a nested failure to the caller rather than hiding it', async () => {
        const runtime = runtimeWithFixtures();
        runtime.resolveActor = (name) => (name === 'test/ok' ? manifest('crash-exit') : manifest('calls-other'));
        const record = await runtime.call(manifest('calls-other'), { n: 1 }, { timeoutSecs: 45 });
        // The nested run crashed, so the caller's await rejects and the run fails.
        expect(record.status).toBe('FAILED');
    }, 60_000);
});

describe('run metrics', () => {
    it('reports memory, cpu and compute units', async () => {
        const runtime = runtimeWithFixtures();
        const record = await runtime.call(manifest('ok'), { n: 2 }, { timeoutSecs: 45, memoryMbytes: 512 });

        expect(record.peakMemoryMb).toBeGreaterThan(0);
        expect(record.cpuMs).toBeGreaterThanOrEqual(0);
        // 0.5 GB for a fraction of an hour: small but not zero.
        expect(record.computeUnits).toBeGreaterThan(0);
    }, 60_000);
});

describe('asynchronous runs', () => {
    it('returns a run that is still going, rather than blocking on it', async () => {
        // The reason this exists: an MCP client gives up after 60 seconds, so a
        // long crawl has to be startable without being waited on.
        const runtime = runtimeWithFixtures();
        const record = await runtime.start(manifest('slow-abortable'), {}, { timeoutSecs: 60 });

        expect(record.id).toMatch(/^run-/);
        expect(['READY', 'RUNNING']).toContain(record.status);

        const finished = await runtime.waitFor(record.id, 60_000);
        expect(finished?.status).toBe('SUCCEEDED');
    }, 90_000);

    it('waitFor returns the run unfinished when the wait runs out', async () => {
        const runtime = runtimeWithFixtures();
        const record = await runtime.start(manifest('slow-abortable'), {}, { timeoutSecs: 60 });

        // Too short to complete: the caller gets progress, not a false result.
        const partial = await runtime.waitFor(record.id, 300);
        expect(partial).toBeDefined();
        expect(['READY', 'RUNNING']).toContain(partial!.status);

        runtime.abort(record.id);
        await runtime.waitFor(record.id, 30_000);
    }, 90_000);

    it('a run started asynchronously still lands in history and its dataset', async () => {
        const runtime = runtimeWithFixtures();
        const record = await runtime.start(manifest('ok'), { n: 3 }, { timeoutSecs: 60 });
        const finished = await runtime.waitFor(record.id, 60_000);

        expect(finished?.itemCount).toBe(3);
        expect(runtime.getRun(record.id)?.status).toBe('SUCCEEDED');
    }, 90_000);

    it('waitFor on an unknown run reports nothing rather than hanging', async () => {
        expect(await runtimeWithFixtures().waitFor('run-does-not-exist', 1000)).toBeUndefined();
    });
});
