import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverActors, searchActors } from '../src/registry.js';

async function fixtureDir(manifests: Record<string, unknown>): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'openactors-'));
    for (const [name, manifest] of Object.entries(manifests)) {
        const dir = join(root, ...name.split('/'));
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, 'actor.json'), JSON.stringify(manifest));
    }
    return root;
}

describe('discoverActors', () => {
    it('names Actors by their namespace and directory', async () => {
        const dir = await fixtureDir({ 'web/thing': { title: 'Thing' } });
        const [actor] = await discoverActors(dir);
        expect(actor.name).toBe('web/thing');
        expect(actor.title).toBe('Thing');
    });

    it('skips a malformed manifest without losing the rest', async () => {
        const dir = await fixtureDir({ 'web/good': { title: 'Good' } });
        await mkdir(join(dir, 'web', 'bad'), { recursive: true });
        await writeFile(join(dir, 'web', 'bad', 'actor.json'), '{ not json');

        const actors = await discoverActors(dir);
        expect(actors.map((a) => a.name)).toEqual(['web/good']);
    });

    // Kept covered even though no shipped Actor currently declares requiresEnv:
    // the mechanism is what lets a credential-needing Actor stay discoverable
    // while refusing to run.
    it('gates an Actor whose required environment is missing', async () => {
        const dir = await fixtureDir({ 'x/needs-env': { title: 'X', requiresEnv: ['DEFINITELY_UNSET_VAR_123'] } });
        const [actor] = await discoverActors(dir);
        expect(actor.gatedReason).toMatch(/DEFINITELY_UNSET_VAR_123/);
    });

    it('leaves an Actor ungated when its environment is present', async () => {
        process.env.OPENACTORS_TEST_VAR = 'set';
        const dir = await fixtureDir({ 'x/needs-env': { title: 'X', requiresEnv: ['OPENACTORS_TEST_VAR'] } });
        const [actor] = await discoverActors(dir);
        expect(actor.gatedReason).toBeUndefined();
        delete process.env.OPENACTORS_TEST_VAR;
    });
});

describe('searchActors', () => {
    const actors = [
        { name: 'jobs/ats-boards', title: 'ATS Job Board Aggregator', description: 'roles from applicant tracking systems', tags: ['jobs', 'ats'] },
        { name: 'web/site-crawler', title: 'Website Content Crawler', description: 'pages as markdown', tags: ['web', 'markdown'] },
    ] as any[];

    it('ranks an id match above a passing mention in prose', () => {
        expect(searchActors(actors, 'crawler')[0].name).toBe('web/site-crawler');
    });

    it('matches on tags', () => {
        expect(searchActors(actors, 'ats')[0].name).toBe('jobs/ats-boards');
    });

    it('returns everything for an empty query, so browsing works', () => {
        expect(searchActors(actors, '')).toHaveLength(2);
    });

    it('returns nothing when there is genuinely no match', () => {
        expect(searchActors(actors, 'quantum tunnelling')).toEqual([]);
    });
});
