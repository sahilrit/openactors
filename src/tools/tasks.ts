import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { resolveActorName } from '../aliases.js';
import type { ActorIndex } from '../registry.js';
import type { Runtime } from '../runtime.js';
import { deleteTask, getTask, loadTasks, runTask, saveTask } from '../tasks.js';
import { fail, previewItems, text } from './shared.js';
import { openDataset } from '../storage.js';

export function registerTaskTools(server: McpServer, index: ActorIndex, runtime: Runtime): void {
    server.registerTool(
        'create-actor-task',
        {
            title: 'Create or update an Actor task',
            description:
                'Save a named Actor configuration so a search worth repeating gets an id ' +
                'instead of a body of JSON to retype. Re-using an existing id updates it.',
            inputSchema: {
                id: z.string().describe('Lowercase letters, digits and hyphens, e.g. "remote-growth-roles".'),
                actor: z.string().describe('Actor id, e.g. "jobs/ats-boards".'),
                input: z.record(z.string(), z.unknown()).default({}),
                title: z.string().optional(),
            },
        },
        async ({ id, actor, input, title }) => {
            try {
                return text(await saveTask({ id, actor, input, title }));
            } catch (err) {
                return fail((err as Error).message);
            }
        },
    );

    server.registerTool(
        'get-actor-task',
        {
            title: 'Get Actor tasks',
            description: 'List saved tasks, or fetch one by id.',
            inputSchema: { id: z.string().optional() },
        },
        async ({ id }) => {
            if (id === undefined) {
                const tasks = await loadTasks();
                return text({ total: tasks.length, tasks });
            }
            const task = await getTask(id);
            return task ? text(task) : fail(`Task "${id}" not found.`);
        },
    );

    server.registerTool(
        'delete-actor-task',
        {
            title: 'Delete an Actor task',
            description: 'Remove a saved task. The runs and datasets it produced are kept.',
            inputSchema: { id: z.string() },
        },
        async ({ id }) => ((await deleteTask(id)) ? text(`Deleted task "${id}".`) : fail(`Task "${id}" not found.`)),
    );

    server.registerTool(
        'run-actor-task',
        {
            title: 'Run an Actor task',
            description:
                'Run a saved task. Any fields given in `input` override the saved ones for ' +
                'this run only, so one task covers a family of similar searches.',
            inputSchema: {
                id: z.string(),
                input: z.record(z.string(), z.unknown()).default({}).describe('Fields to override for this run.'),
            },
        },
        async ({ id, input }) => {
            try {
                await index.refresh();
                const record = await runTask(id, input, runtime, (name) => index.find(name, resolveActorName));
                const dataset = await openDataset(record.defaultDatasetId);
                const { items } = await dataset.getData({ limit: 50 });
                const { shown } = previewItems(items);
                return text({ ...record, log: undefined, items: shown });
            } catch (err) {
                return fail((err as Error).message);
            }
        },
    );

    server.registerTool(
        'resurrect-actor-run',
        {
            title: 'Resurrect an Actor run',
            description:
                'Re-run a finished run with the same Actor and input, optionally with a longer ' +
                'timeout — the usual reason a run needs resurrecting. Creates a new run, so the ' +
                "original's results and diagnosis stay intact.",
            inputSchema: {
                runId: z.string(),
                timeoutSecs: z.number().int().min(5).max(3600).optional(),
            },
        },
        async ({ runId, timeoutSecs }) => {
            try {
                await index.refresh();
                const record = await runtime.resurrect(runId, (name) => index.find(name, resolveActorName), timeoutSecs);
                return text({ ...record, log: undefined });
            } catch (err) {
                return fail((err as Error).message);
            }
        },
    );
}
