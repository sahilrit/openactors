import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { cleanupStorages } from '../retention.js';
import { deleteSchedule, loadSchedules, saveSchedule } from '../schedules.js';
import { fail, text } from './shared.js';

export function registerScheduleTools(server: McpServer): void {
    server.registerTool(
        'create-schedule',
        {
            title: 'Create or update a schedule',
            description:
                'Run an Actor or a saved task on a cron schedule, executed by the server ' +
                'itself. Give either `actor` with inline `input`, or `task`. Re-using an id updates it.',
            inputSchema: {
                id: z.string().describe('Lowercase letters, digits and hyphens.'),
                cron: z.string().describe('Standard 5-field cron, e.g. "0 */6 * * *".'),
                actor: z.string().optional(),
                task: z.string().optional(),
                input: z.record(z.string(), z.unknown()).optional(),
                timezone: z.string().optional().describe('IANA zone, e.g. "Asia/Kolkata". Defaults to UTC.'),
                enabled: z.boolean().default(true),
                title: z.string().optional(),
            },
        },
        async (args) => {
            try {
                return text(await saveSchedule(args as Record<string, unknown>));
            } catch (err) {
                return fail((err as Error).message);
            }
        },
    );

    server.registerTool(
        'get-schedules',
        {
            title: 'List schedules',
            description: 'List schedules with their next and last run times.',
            inputSchema: {},
        },
        async () => {
            const schedules = await loadSchedules();
            return text({ total: schedules.length, schedules });
        },
    );

    server.registerTool(
        'delete-schedule',
        {
            title: 'Delete a schedule',
            description: 'Remove a schedule. Runs it already produced are kept.',
            inputSchema: { id: z.string() },
        },
        async ({ id }) => ((await deleteSchedule(id)) ? text(`Deleted schedule "${id}".`) : fail(`Schedule "${id}" not found.`)),
    );

    server.registerTool(
        'clean-up-storage',
        {
            title: 'Clean up old storage',
            description:
                'Delete datasets and stores older than `keepDays`. Every run creates a dataset, ' +
                'so these accumulate; configuration stores are never removed. Use dryRun first.',
            inputSchema: {
                keepDays: z.number().int().min(1).max(365).default(7),
                dryRun: z.boolean().default(true),
            },
        },
        async ({ keepDays, dryRun }) => {
            const result = await cleanupStorages({ keepDays, dryRun });
            return text({
                dryRun,
                removedCount: result.removed.length,
                keptCount: result.kept,
                freedMb: Math.round((result.freedBytes / 1_048_576) * 10) / 10,
                removed: result.removed.slice(0, 50),
            });
        },
    );
}
