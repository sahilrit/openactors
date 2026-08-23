import { createRequire } from 'node:module';
import type { ErrorObject, ValidateFunction } from 'ajv';
import type { InputSchema } from './types.js';

// Ajv and ajv-formats are CommonJS. Under NodeNext resolution their default
// export arrives as the module namespace rather than the constructor, so a
// plain `import Ajv from 'ajv'` is not constructable. createRequire loads them
// the way they were published, which is the one form that works in every
// consumer regardless of bundling.
const require = createRequire(import.meta.url);

interface AjvLike {
    compile(schema: unknown): ValidateFunction;
}
type AjvConstructor = new (options: Record<string, unknown>) => AjvLike;

const Ajv = require('ajv') as AjvConstructor & { default?: AjvConstructor };
const addFormats = require('ajv-formats') as ((ajv: AjvLike) => void) & { default?: (ajv: AjvLike) => void };

/**
 * Validates Actor input against the JSON Schema in its actor.json, the way
 * Apify validates before starting a run.
 *
 * Failing here rather than inside the Actor matters: a typo'd field name
 * otherwise runs a full crawl with a silently-ignored parameter and returns
 * plausible, wrong results. `additionalProperties: false` in the manifests
 * turns that into an error naming the unknown key.
 *
 * Defaults declared in the schema are applied to the input, so an Actor reads
 * one source of truth for them instead of repeating them in its own signature.
 */
const ajv = new (Ajv.default ?? Ajv)({
    useDefaults: true,
    coerceTypes: true, // a "10" arriving over HTTP query params is an integer
    allErrors: true,
    strict: false, // manifests carry documentation keywords Ajv does not know
});
(addFormats.default ?? addFormats)(ajv);

const cache = new Map<string, ValidateFunction>();

function compile(actorName: string, schema: InputSchema): ValidateFunction {
    const cached = cache.get(actorName);
    if (cached) return cached;
    const validate = ajv.compile(schema);
    cache.set(actorName, validate);
    return validate;
}

/** Forgets a compiled schema, so an edited actor.json takes effect without a restart. */
export function invalidateSchema(actorName: string): void {
    cache.delete(actorName);
}

function describe(error: ErrorObject): string {
    const path = error.instancePath.replace(/^\//, '').replace(/\//g, '.');
    const where = path === '' ? 'input' : `"${path}"`;

    switch (error.keyword) {
        case 'required':
            return `missing required field "${(error.params as { missingProperty: string }).missingProperty}"`;
        case 'additionalProperties':
            return `unknown field "${(error.params as { additionalProperty: string }).additionalProperty}"`;
        case 'type':
            return `${where} must be ${(error.params as { type: string }).type}`;
        case 'enum':
            return `${where} must be one of: ${((error.params as { allowedValues: unknown[] }).allowedValues ?? []).join(', ')}`;
        case 'minimum':
        case 'maximum':
        case 'minItems':
        case 'maxItems':
        case 'minLength':
        case 'maxLength':
            return `${where} ${error.message}`;
        default:
            return `${where} ${error.message ?? 'is invalid'}`;
    }
}

export interface ValidationResult {
    valid: boolean;
    /** Input with schema defaults applied. Only meaningful when valid. */
    value: Record<string, unknown>;
    errors: string[];
}

export function validateInput(
    actorName: string,
    schema: InputSchema,
    input: unknown,
): ValidationResult {
    // Ajv mutates the value when applying defaults and coercing, so it gets a
    // copy — a caller's object must not change under it.
    const value = JSON.parse(JSON.stringify(input ?? {})) as Record<string, unknown>;

    let validate: ValidateFunction;
    try {
        validate = compile(actorName, schema);
    } catch (err) {
        // A broken manifest schema must not block the Actor entirely; say so
        // and let it run unvalidated rather than making it uncallable.
        return { valid: true, value, errors: [`schema for "${actorName}" could not be compiled: ${(err as Error).message}`] };
    }

    if (validate(value)) return { valid: true, value, errors: [] };

    // Deduplicated: allErrors reports the same missing field once per subschema.
    const errors = [...new Set((validate.errors ?? []).map(describe))];
    return { valid: false, value, errors };
}
