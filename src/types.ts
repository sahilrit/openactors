/**
 * Core contracts. Actors depend only on this file — never on the MCP server,
 * the registry, or storage. That one-way dependency is what keeps an Actor
 * testable in isolation and portable between runtimes.
 */

/** JSON Schema describing an Actor's `input` object. */
export type InputSchema = {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
};

/** Parsed contents of an `actor.json` manifest, plus where it came from. */
export interface ActorManifest {
    /** Namespaced id, e.g. `web/site-crawler`. Derived from the directory path. */
    name: string;
    title: string;
    description: string;
    tags: string[];
    input: InputSchema;
    /** Absolute path to the Actor's directory. */
    dir: string;
    /**
     * Environment variables the Actor cannot run without. Declared in
     * actor.json so the gate is visible to discovery rather than buried in the
     * Actor's own code — an agent can see *why* it cannot run something.
     */
    requiresEnv?: string[];
    /**
     * Set when the Actor refuses to run without configuration (an API key, a
     * session credential). Discovery still lists it; `call-actor` reports this
     * instead of running, so an agent can say what needs configuring rather
     * than reporting a missing tool.
     */
    gatedReason?: string;
}

/**
 * Run states, matching Apify's model.
 *
 * The distinctions earn their keep: a run that exceeded its time limit
 * (TIMED-OUT) is a different diagnosis from one a caller stopped (ABORTED),
 * and collapsing them — as an earlier version did — makes a too-short timeout
 * look like user action. The transitional states exist so a caller polling a
 * run can tell "stopping" from "stopped".
 */
export const RUN_STATUSES = [
    'READY',
    'RUNNING',
    'TIMING-OUT',
    'ABORTING',
    'SUCCEEDED',
    'FAILED',
    'TIMED-OUT',
    'ABORTED',
] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];

const TERMINAL: ReadonlySet<string> = new Set(['SUCCEEDED', 'FAILED', 'TIMED-OUT', 'ABORTED']);

export function isTerminal(status: RunStatus): boolean {
    return TERMINAL.has(status);
}

export interface RunRecord {
    id: string;
    actorName: string;
    status: RunStatus;
    startedAt: string;
    finishedAt?: string;
    /** Wall-clock milliseconds, set once the run reaches a terminal state. */
    durationMs?: number;
    /** Name of the Crawlee Dataset holding this run's items. */
    defaultDatasetId: string;
    itemCount: number;
    input: unknown;
    /** Timeout the run was started with, so a resurrection can raise it. */
    timeoutSecs?: number;
    errorMessage?: string;
    /** How the run was started, mirroring Apify's meta.origin. */
    origin?: 'API' | 'MCP' | 'SCHEDULER' | 'RESURRECTION' | 'WEBHOOK';
    /** Id of the run this one was resurrected from. */
    resurrectedFrom?: string;
    /** Newest-last, capped in the runtime to bound memory. */
    log: string[];
}

/**
 * Everything an Actor is allowed to touch. Deliberately small: push results,
 * write a log line, and notice when it should stop.
 */
export interface ActorContext {
    /**
     * Id of the current run. Actors that need their own scratch storage (a
     * request queue, say) must key it on this. Crawlee's *default* storages
     * persist between runs, so an Actor reusing them would see the previous
     * run's state and silently skip work.
     */
    runId: string;
    pushData(item: Record<string, unknown> | Record<string, unknown>[]): Promise<void>;
    log(message: string): void;
    signal: AbortSignal;
}

/** The single export every Actor's `main.ts` must provide. */
export type ActorRunFn = (input: any, ctx: ActorContext) => Promise<void>;
