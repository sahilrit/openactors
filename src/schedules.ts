import { CronExpressionParser } from 'cron-parser';
import { resolveActorName } from './aliases.js';
import type { Runtime } from './runtime.js';
import { openKeyValueStore } from './storage.js';
import { getTask, runTask } from './tasks.js';
import type { ActorManifest } from './types.js';

/**
 * Cron schedules run by the server itself.
 *
 * The digest already had scheduling through launchd, which works but is
 * macOS-only, invisible to the API, and unmanageable from a client. This is the
 * same capability as a first-class resource: created over REST or MCP,
 * inspectable, and portable to anywhere the server runs.
 */

export interface Schedule {
    id: string;
    cron: string;
    /** Either an Actor id with inline input, or a saved task id. */
    actor?: string;
    input?: Record<string, unknown>;
    task?: string;
    timezone?: string;
    enabled: boolean;
    title?: string;
    createdAt: string;
    lastRunAt?: string;
    lastRunId?: string;
    lastError?: string;
    nextRunAt?: string;
}

const STORE = 'schedules';
const KEY = 'schedules';
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export async function loadSchedules(): Promise<Schedule[]> {
    const store = await openKeyValueStore(STORE);
    return (await store.getValue<Schedule[]>(KEY)) ?? [];
}

async function writeSchedules(schedules: Schedule[]): Promise<void> {
    const store = await openKeyValueStore(STORE);
    await store.setValue(KEY, schedules);
}

/** Next firing after `from`, or null if the expression cannot be parsed. */
export function nextRun(cron: string, timezone: string | undefined, from: Date): Date | null {
    try {
        return CronExpressionParser.parse(cron, { currentDate: from, tz: timezone ?? 'UTC' }).next().toDate();
    } catch {
        return null;
    }
}

export function validateCron(cron: string, timezone?: string): string | null {
    try {
        CronExpressionParser.parse(cron, { tz: timezone ?? 'UTC' });
        return null;
    } catch (err) {
        return (err as Error).message;
    }
}

export async function saveSchedule(raw: Record<string, unknown>): Promise<Schedule> {
    const id = String(raw.id ?? '').trim().toLowerCase();
    const cron = String(raw.cron ?? '').trim();

    if (!ID_PATTERN.test(id)) {
        throw new Error('id must be 1-64 characters of lowercase letters, digits or hyphens, starting alphanumeric');
    }
    if (!raw.actor && !raw.task) throw new Error('either "actor" or "task" is required');
    if (raw.actor && raw.task) throw new Error('give either "actor" or "task", not both');

    const timezone = raw.timezone ? String(raw.timezone) : undefined;
    const cronError = validateCron(cron, timezone);
    // Rejected on save rather than at fire time: a schedule that silently never
    // runs is far harder to notice than one that refuses to be created.
    if (cronError) throw new Error(`invalid cron expression "${cron}": ${cronError}`);

    const schedules = await loadSchedules();
    const existing = schedules.find((s) => s.id === id);
    const now = new Date();

    const schedule: Schedule = {
        id,
        cron,
        ...(raw.actor ? { actor: String(raw.actor) } : {}),
        ...(raw.task ? { task: String(raw.task) } : {}),
        ...(raw.input ? { input: raw.input as Record<string, unknown> } : {}),
        ...(timezone ? { timezone } : {}),
        ...(raw.title ? { title: String(raw.title) } : {}),
        enabled: raw.enabled === undefined ? true : Boolean(raw.enabled),
        createdAt: existing?.createdAt ?? now.toISOString(),
        lastRunAt: existing?.lastRunAt,
        lastRunId: existing?.lastRunId,
        nextRunAt: nextRun(cron, timezone, now)?.toISOString(),
    };

    await writeSchedules([...schedules.filter((s) => s.id !== id), schedule]);
    return schedule;
}

export async function deleteSchedule(id: string): Promise<boolean> {
    const schedules = await loadSchedules();
    const remaining = schedules.filter((s) => s.id !== id);
    if (remaining.length === schedules.length) return false;
    await writeSchedules(remaining);
    return true;
}

export interface SchedulerDeps {
    runtime: Runtime;
    resolveActor(name: string): ActorManifest | undefined;
    refresh(): Promise<unknown>;
}

/**
 * Fires schedules whose time has come.
 *
 * It ticks on a fixed interval rather than sleeping until the next due time,
 * because schedules can be added or edited between ticks and a sleeping timer
 * would miss them. A minute's granularity matches cron's own.
 */
export class Scheduler {
    private timer?: NodeJS.Timeout;
    private ticking = false;

    constructor(
        private readonly deps: SchedulerDeps,
        private readonly intervalMs = 30_000,
    ) {}

    start(): void {
        if (this.timer) return;
        this.timer = setInterval(() => void this.tick(), this.intervalMs);
        // Do not hold the process open: a server should exit when asked, and a
        // bare interval would keep it alive indefinitely.
        this.timer.unref();
        void this.tick();
    }

    stop(): void {
        clearInterval(this.timer);
        this.timer = undefined;
    }

    /** Runs every schedule that is due. Safe to call directly, for tests. */
    async tick(now = new Date()): Promise<number> {
        // A slow run must not let the next tick fire the same schedule again.
        if (this.ticking) return 0;
        this.ticking = true;

        try {
            const schedules = await loadSchedules();
            const due = schedules.filter((s) => s.enabled && s.nextRunAt && new Date(s.nextRunAt) <= now);
            if (due.length === 0) return 0;

            for (const schedule of due) {
                // The next time is written before the run starts, so a run that
                // takes longer than the interval cannot be started twice.
                schedule.nextRunAt = nextRun(schedule.cron, schedule.timezone, now)?.toISOString();
                schedule.lastRunAt = now.toISOString();
            }
            await writeSchedules(schedules);

            await Promise.allSettled(due.map((schedule) => this.fire(schedule)));
            return due.length;
        } finally {
            this.ticking = false;
        }
    }

    private async fire(schedule: Schedule): Promise<void> {
        const { runtime, resolveActor, refresh } = this.deps;
        let error: string | undefined;
        let runId: string | undefined;

        try {
            await refresh();

            if (schedule.task) {
                const task = await getTask(schedule.task);
                if (!task) throw new Error(`task "${schedule.task}" no longer exists`);
                runId = (await runTask(schedule.task, schedule.input ?? {}, runtime, resolveActor)).id;
            } else {
                const manifest = resolveActor(resolveActorName(schedule.actor!));
                if (!manifest) throw new Error(`Actor "${schedule.actor}" is not installed`);
                runId = (await runtime.call(manifest, schedule.input ?? {}, { origin: 'SCHEDULER' })).id;
            }
        } catch (err) {
            error = (err as Error).message;
            console.error(`[scheduler] ${schedule.id}: ${error}`);
        }

        // Re-read rather than reusing the earlier copy: the run may have taken
        // longer than a tick, and another edit could have landed meanwhile.
        const schedules = await loadSchedules();
        const stored = schedules.find((s) => s.id === schedule.id);
        if (!stored) return;

        stored.lastRunId = runId;
        stored.lastError = error;
        await writeSchedules(schedules);
    }
}
