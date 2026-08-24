import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { mergeMark, type Mark, type MarkStore } from '../digest/marks.js';
import { openKeyValueStore } from '../storage.js';
import { fail, text } from './shared.js';

const STORE = 'job-marks';
const KEY = 'marks';

async function load(): Promise<MarkStore> {
    const store = await openKeyValueStore(STORE);
    return (await store.getValue<MarkStore>(KEY)) ?? {};
}

async function save(marks: MarkStore): Promise<void> {
    const store = await openKeyValueStore(STORE);
    await store.setValue(KEY, marks);
}

export function registerMarkTools(server: McpServer): void {
    server.registerTool(
        'mark-job',
        {
            title: 'Mark a job as applied or ignored',
            description:
                'Record that you have applied to a role or dismissed it. Marked roles stop ' +
                'appearing in future digests, which is what turns the digest from a feed into ' +
                'a working list. Accepts several URLs at once.',
            inputSchema: {
                urls: z.array(z.string()).min(1).describe('Job URLs, as shown in the digest.'),
                mark: z.enum(['applied', 'ignored']),
                note: z.string().optional().describe('Optional label kept alongside the mark.'),
            },
        },
        async ({ urls, mark, note }) => {
            let marks = await load();
            for (const url of urls) marks = mergeMark(marks, url, mark as Mark, { title: note });
            await save(marks);

            const counts = Object.values(marks).reduce<Record<string, number>>((acc, m) => {
                acc[m.mark] = (acc[m.mark] ?? 0) + 1;
                return acc;
            }, {});
            return text({ marked: urls.length, as: mark, totals: counts });
        },
    );

    server.registerTool(
        'get-marked-jobs',
        {
            title: 'List marked jobs',
            description: 'List roles recorded as applied or ignored, newest first.',
            inputSchema: {
                mark: z.enum(['applied', 'ignored']).optional().describe('Omit to list both.'),
                limit: z.number().int().min(1).max(500).default(100),
            },
        },
        async ({ mark, limit }) => {
            const marks = await load();
            const rows = Object.entries(marks)
                .filter(([, record]) => (mark ? record.mark === mark : true))
                .sort((a, b) => b[1].markedAt.localeCompare(a[1].markedAt))
                .slice(0, limit)
                .map(([url, record]) => ({ url, ...record }));
            return text({ total: rows.length, jobs: rows });
        },
    );

    server.registerTool(
        'unmark-job',
        {
            title: 'Remove a job mark',
            description: 'Forget that a role was applied to or ignored, so it can appear again.',
            inputSchema: { urls: z.array(z.string()).min(1) },
        },
        async ({ urls }) => {
            const marks = await load();
            let removed = 0;
            for (const url of urls) {
                // Marks are keyed without query strings, so normalise here too
                // or a URL copied with tracking parameters would never match.
                const key = url.split('?')[0];
                if (key in marks) {
                    delete marks[key];
                    removed++;
                }
            }
            if (removed === 0) return fail('None of those URLs were marked.');
            await save(marks);
            return text({ removed, remaining: Object.keys(marks).length });
        },
    );
}
