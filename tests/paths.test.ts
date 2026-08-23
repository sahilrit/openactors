import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { PROJECT_ROOT } from '../src/paths.js';

/**
 * Regression guard. Both storage and the digest config resolve paths relative
 * to the project root, and both were once wrong: a hardcoded `..` count is
 * correct from `src/` and off by one from a compiled `dist/src/`, or off by two
 * from `dist/src/digest/`. The symptom is quiet — storage written into `dist/`,
 * or searches.json looked for in the wrong directory.
 */
describe('PROJECT_ROOT', () => {
    it('points at the directory holding package.json', () => {
        expect(existsSync(join(PROJECT_ROOT, 'package.json'))).toBe(true);
    });

    it('is the repository root, not a build directory', () => {
        expect(existsSync(join(PROJECT_ROOT, 'actors'))).toBe(true);
        expect(PROJECT_ROOT.endsWith('dist')).toBe(false);
    });
});
