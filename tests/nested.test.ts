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
