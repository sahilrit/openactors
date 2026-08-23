import { openKeyValueStore } from './storage.js';
import type { ActorManifest, RunRecord } from './types.js';
import type { Runtime } from './runtime.js';

/**
 * Named, saved Actor configurations — Apify's "tasks".
 *
 * The value is that a search worth repeating gets an id instead of a body of
 * JSON that has to be retyped correctly every time. A task run may override
 * individual input fields, so one saved task covers a family of similar calls.
 */
export interface ActorTask {
    id: string;
    actor: string;
    input: Record<string, unknown>;
    title?: string;
    createdAt: string;
    updatedAt: string;
}

const STORE = 'tasks';
const KEY = 'tasks';

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export async function loadTasks(): Promise<ActorTask[]> {
    const store = await openKeyValueStore(STORE);
    return (await store.getValue<ActorTask[]>(KEY)) ?? [];
}

async function writeTasks(tasks: ActorTask[]): Promise<void> {
    const store = await openKeyValueStore(STORE);
    await store.setValue(KEY, tasks);
}

export async function getTask(id: string): Promise<ActorTask | undefined> {
    return (await loadTasks()).find((task) => task.id === id);
}

export async function saveTask(raw: Record<string, unknown>): Promise<ActorTask> {
    const id = String(raw.id ?? '').trim().toLowerCase();
    const actor = String(raw.actor ?? '').trim();

    // Ids go in URLs, so they are constrained rather than sanitised — quietly
    // rewriting an id would make the task unreachable under the name given.
    if (!ID_PATTERN.test(id)) {
        throw new Error('id must be 1-64 characters of lowercase letters, digits or hyphens, starting alphanumeric');
    }
    if (actor === '') throw new Error('actor is required, e.g. "jobs/ats-boards"');
    if (raw.input !== undefined && (typeof raw.input !== 'object' || raw.input === null || Array.isArray(raw.input))) {
        throw new Error('input must be an object');
    }

    const tasks = await loadTasks();
    const now = new Date().toISOString();
    const existing = tasks.find((task) => task.id === id);

    const task: ActorTask = {
        id,
        actor,
        input: (raw.input as Record<string, unknown>) ?? {},
        ...(raw.title ? { title: String(raw.title) } : {}),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
    };

    await writeTasks([...tasks.filter((t) => t.id !== id), task]);
    return task;
}

export async function deleteTask(id: string): Promise<boolean> {
    const tasks = await loadTasks();
    const remaining = tasks.filter((task) => task.id !== id);
    if (remaining.length === tasks.length) return false;
    await writeTasks(remaining);
    return true;
}

/**
 * Runs a saved task, with per-call overrides merged over its stored input.
 * The merge is shallow, matching Apify: a nested object is replaced wholesale
 * rather than deep-merged, which keeps the result predictable.
 */
export async function runTask(
    id: string,
    overrides: Record<string, unknown>,
    runtime: Runtime,
    resolve: (actorName: string) => ActorManifest | undefined,
): Promise<RunRecord> {
    const task = await getTask(id);
    if (!task) throw new Error(`Task "${id}" not found.`);

    const manifest = resolve(task.actor);
    if (!manifest) throw new Error(`Task "${id}" refers to Actor "${task.actor}", which is not installed.`);

    return runtime.call(manifest, { ...task.input, ...overrides }, { origin: 'API' });
}
