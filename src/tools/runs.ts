import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Runtime } from '../runtime.js';
import { fail, text } from './shared.js';

/** Run records live in memory, so they are lost on restart; datasets are not. */
export function registerRunTools(server: McpServer, runtime: Runtime): void {
    server.registerTool(
        'get-actor-run',
        {
            title: 'Get Actor run',
            description:
                'Get the status, item count and dataset id of a previous run. Use this after ' +
                'call-actor to check whether a run succeeded, failed, or was aborted.',
            inputSchema: { runId: z.string() },
        },
        async ({ runId }) => {
            const record = runtime.getRun(runId);
            if (!record) return fail(`Run "${runId}" not found. Runs are kept in memory and are lost when the server restarts.`);
            const { log, ...summary } = record;
            return text({ ...summary, logLines: log.length });
        },
    );

    server.registerTool(
        'get-actor-run-list',
        {
            title: 'List Actor runs',
            description: 'List recent Actor runs in this server session, newest first.',
            inputSchema: { limit: z.number().int().min(1).max(200).default(20) },
        },
        async ({ limit }) => {
            const runs = runtime.listRuns(limit).map(({ log, input, ...summary }) => summary);
            return text({ total: runs.length, runs });
        },
    );

    server.registerTool(
        'get-actor-log',
        {
            title: 'Get Actor run log',
            description:
                'Read the log of a run. This is where an Actor reports per-board or per-page ' +
                'failures that did not fail the run as a whole — check it when a run succeeded ' +
                'but returned fewer items than you expected.',
            inputSchema: {
                runId: z.string(),
                tail: z.number().int().min(1).max(500).default(100).describe('Return only the last N lines.'),
            },
        },
        async ({ runId, tail }) => {
            const record = runtime.getRun(runId);
            if (!record) return fail(`Run "${runId}" not found.`);
            const lines = record.log.slice(-tail);
            return text(lines.length > 0 ? lines.join('\n') : '(no log output)');
        },
    );

    server.registerTool(
        'abort-actor-run',
        {
            title: 'Abort Actor run',
            description: 'Stop a run that is still in progress. Items already collected are kept.',
            inputSchema: { runId: z.string() },
        },
        async ({ runId }) => {
            const record = runtime.getRun(runId);
            if (!record) return fail(`Run "${runId}" not found.`);
            const aborted = runtime.abort(runId);
            return text(
                aborted
                    ? `Abort signalled for ${runId}. The Actor stops at its next checkpoint.`
                    : `Run ${runId} is not running (status: ${record.status}).`,
            );
        },
    );
}
