import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { openDataset, openKeyValueStore } from '../storage.js';
import { fail, previewItems, text } from './shared.js';

/** Infers a flat JSON Schema from a sample of items. */
function inferSchema(items: Record<string, unknown>[]): unknown {
    const seen = new Map<string, Set<string>>();
    for (const item of items) {
        for (const [key, value] of Object.entries(item)) {
            const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
            if (!seen.has(key)) seen.set(key, new Set());
            seen.get(key)!.add(type);
        }
    }
    const properties = Object.fromEntries(
        [...seen].map(([key, types]) => {
            const concrete = [...types].filter((t) => t !== 'null');
            return [key, { type: concrete.length === 1 ? concrete[0] : concrete, nullable: types.has('null') }];
        }),
    );
    // A key missing from any item cannot be required.
    const required = [...seen.keys()].filter((k) => items.every((i) => k in i));
    return { type: 'object', properties, required };
}

export function registerStorageTools(server: McpServer): void {
    server.registerTool(
        'get-dataset-items',
        {
            title: 'Get dataset items',
            description:
                'Page through the results of a previous Actor run. Use the datasetId returned ' +
                'by call-actor. Use `fields` to project only the keys you need — this matters ' +
                'when items contain long text such as page content or job descriptions.',
            inputSchema: {
                datasetId: z.string(),
                offset: z.number().int().min(0).default(0),
                limit: z.number().int().min(1).max(200).default(10),
                fields: z.array(z.string()).optional().describe('Only return these top-level keys.'),
            },
        },
        async ({ datasetId, offset, limit, fields }) => {
            let dataset;
            try {
                dataset = await openDataset(datasetId);
            } catch {
                return fail(`Dataset "${datasetId}" not found.`);
            }

            const { items, total } = await dataset.getData({ offset, limit });
            const projected =
                fields && fields.length > 0
                    ? items.map((item) => Object.fromEntries(fields.filter((f) => f in item).map((f) => [f, item[f]])))
                    : items;
            const { shown, truncated } = previewItems(projected);

            return text({
                datasetId,
                total,
                offset,
                returned: shown.length,
                ...(truncated > 0
                    ? { note: `${truncated} item(s) withheld to fit the response budget. Narrow with \`fields\` or a smaller \`limit\`.` }
                    : {}),
                items: shown,
            });
        },
    );

    server.registerTool(
        'get-dataset',
        {
            title: 'Get dataset metadata',
            description: 'Get the item count of a dataset without reading the items themselves.',
            inputSchema: { datasetId: z.string() },
        },
        async ({ datasetId }) => {
            try {
                const dataset = await openDataset(datasetId);
                const { total } = await dataset.getData({ limit: 1 });
                return text({ datasetId, itemCount: total });
            } catch {
                return fail(`Dataset "${datasetId}" not found.`);
            }
        },
    );

    server.registerTool(
        'get-dataset-schema',
        {
            title: 'Get dataset schema',
            description:
                'Infer the shape of a dataset from a sample of its items. Use this to learn ' +
                'which fields exist before requesting them via `fields`, instead of pulling ' +
                'whole items to find out.',
            inputSchema: {
                datasetId: z.string(),
                sampleSize: z.number().int().min(1).max(200).default(20),
            },
        },
        async ({ datasetId, sampleSize }) => {
            try {
                const dataset = await openDataset(datasetId);
                const { items, total } = await dataset.getData({ limit: sampleSize });
                if (items.length === 0) return text({ datasetId, itemCount: 0, schema: null });
                return text({ datasetId, itemCount: total, sampled: items.length, schema: inferSchema(items) });
            } catch {
                return fail(`Dataset "${datasetId}" not found.`);
            }
        },
    );

    server.registerTool(
        'get-key-value-store-record',
        {
            title: 'Get key-value store record',
            description: 'Read a single record from a key-value store by key.',
            inputSchema: {
                storeId: z.string().default('default'),
                key: z.string(),
            },
        },
        async ({ storeId, key }) => {
            try {
                const store = await openKeyValueStore(storeId);
                const value = await store.getValue(key);
                if (value === null || value === undefined) return fail(`Key "${key}" not found in store "${storeId}".`);
                return text({ storeId, key, value });
            } catch {
                return fail(`Key-value store "${storeId}" not found.`);
            }
        },
    );
}
