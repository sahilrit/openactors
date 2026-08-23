import { describe, expect, it } from 'vitest';
import { invalidateSchema, validateInput } from '../src/validate.js';
import type { InputSchema } from '../src/types.js';

const SCHEMA: InputSchema = {
    type: 'object',
    properties: {
        keywords: { type: 'string' },
        maxResults: { type: 'integer', default: 25, minimum: 1, maximum: 100 },
        boards: { type: 'array', items: { type: 'string' } },
        mode: { type: 'string', enum: ['fast', 'thorough'] },
    },
    required: ['keywords'],
    additionalProperties: false,
};

describe('validateInput', () => {
    it('accepts valid input and applies schema defaults', () => {
        const result = validateInput('a', SCHEMA, { keywords: 'x' });
        expect(result.valid).toBe(true);
        expect(result.value.maxResults).toBe(25);
    });

    it('names a missing required field', () => {
        expect(validateInput('b', SCHEMA, {}).errors).toEqual(['missing required field "keywords"']);
    });

    it('names an unknown field, which is usually a typo', () => {
        // The failure this prevents: a misspelled parameter is silently ignored
        // and the run returns plausible, wrong results.
        expect(validateInput('c', SCHEMA, { keywords: 'x', maxResult: 5 }).errors).toEqual(['unknown field "maxResult"']);
    });

    it('enforces numeric bounds', () => {
        expect(validateInput('d', SCHEMA, { keywords: 'x', maxResults: 0 }).errors[0]).toMatch(/>= 1/);
        expect(validateInput('e', SCHEMA, { keywords: 'x', maxResults: 500 }).errors[0]).toMatch(/<= 100/);
    });

    it('lists the allowed values for a bad enum', () => {
        expect(validateInput('f', SCHEMA, { keywords: 'x', mode: 'sideways' }).errors[0]).toContain('fast, thorough');
    });

    it('reports a wrong type', () => {
        expect(validateInput('g', SCHEMA, { keywords: 'x', boards: 'nope' }).errors[0]).toContain('must be array');
    });

    it('coerces a numeric string, so query-string input works', () => {
        expect(validateInput('h', SCHEMA, { keywords: 'x', maxResults: '30' }).value.maxResults).toBe(30);
    });

    it('does not mutate the caller\'s object', () => {
        const input = { keywords: 'x' };
        validateInput('i', SCHEMA, input);
        expect(input).toEqual({ keywords: 'x' });
    });

    it('reports every problem at once rather than one per attempt', () => {
        const errors = validateInput('j', SCHEMA, { nope: 1 }).errors;
        expect(errors.length).toBeGreaterThan(1);
    });

    it('lets an Actor run when its own schema is unusable, rather than blocking it', () => {
        invalidateSchema('k');
        const broken = { type: 'object', properties: { a: { type: 'not-a-type' } } } as unknown as InputSchema;
        const result = validateInput('k', broken, { a: 1 });
        expect(result.valid).toBe(true);
        expect(result.errors[0]).toMatch(/could not be compiled/);
    });
});
