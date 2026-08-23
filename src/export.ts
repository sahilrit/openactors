import type { Workbook } from 'exceljs';

/**
 * Dataset export, matching the formats Apify's dataset API offers.
 *
 * Everything except Excel is produced without a dependency: these are simple
 * text formats, and a scraping tool that pulls a spreadsheet library in to emit
 * a CSV has its priorities wrong.
 */
export const EXPORT_FORMATS = ['json', 'jsonl', 'csv', 'xml', 'html', 'rss', 'xlsx'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export const CONTENT_TYPES: Record<ExportFormat, string> = {
    json: 'application/json; charset=utf-8',
    jsonl: 'application/x-ndjson; charset=utf-8',
    csv: 'text/csv; charset=utf-8',
    xml: 'application/xml; charset=utf-8',
    html: 'text/html; charset=utf-8',
    rss: 'application/rss+xml; charset=utf-8',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

export interface ExportOptions {
    /** Keep only these keys, in this order. */
    fields?: string[];
    /** Drop these keys. Takes precedence over `fields`, as it does on Apify. */
    omit?: string[];
    /** Drop keys beginning with `#`, which mark debug fields by convention. */
    clean?: boolean;
}

type Item = Record<string, unknown>;

export function project(items: Item[], options: ExportOptions = {}): Item[] {
    const { fields, omit, clean } = options;
    if (!fields && !omit && !clean) return items;

    const omitSet = new Set(omit ?? []);

    return items.map((item) => {
        const keys = fields ?? Object.keys(item);
        const out: Item = {};
        for (const key of keys) {
            if (!(key in item)) continue;
            if (omitSet.has(key)) continue;
            if (clean && key.startsWith('#')) continue;
            out[key] = item[key];
        }
        return out;
    });
}

/** Union of keys across all items — a later row may carry a field the first lacks. */
export function columnsOf(items: Item[], fields?: string[]): string[] {
    if (fields && fields.length > 0) return fields;
    const seen = new Set<string>();
    for (const item of items) for (const key of Object.keys(item)) seen.add(key);
    return [...seen];
}

function scalar(value: unknown): string {
    if (value === null || value === undefined) return '';
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
}

function csvCell(value: unknown): string {
    const text = scalar(value);
    // Quote when the value could otherwise break the row, and double any
    // embedded quote, per RFC 4180.
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(items: Item[], fields?: string[]): string {
    const columns = columnsOf(items, fields);
    const rows = [columns.map(csvCell).join(',')];
    for (const item of items) rows.push(columns.map((c) => csvCell(item[c])).join(','));
    // A trailing newline is what every CSV reader expects of a complete file.
    return `${rows.join('\n')}\n`;
}

const escapeXml = (value: string): string =>
    value.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]!);

/** XML element names cannot start with a digit or contain arbitrary characters. */
function xmlTag(key: string): string {
    const cleaned = key.replace(/[^A-Za-z0-9_.-]/g, '_');
    return /^[A-Za-z_]/.test(cleaned) ? cleaned : `_${cleaned}`;
}

export function toXml(items: Item[]): string {
    const body = items
        .map((item) => {
            const fields = Object.entries(item)
                .map(([key, value]) => `    <${xmlTag(key)}>${escapeXml(scalar(value))}</${xmlTag(key)}>`)
                .join('\n');
            return `  <item>\n${fields}\n  </item>`;
        })
        .join('\n');
    return `<?xml version="1.0" encoding="UTF-8"?>\n<items>\n${body}\n</items>\n`;
}

export function toHtml(items: Item[], fields?: string[]): string {
    const columns = columnsOf(items, fields);
    const head = columns.map((c) => `<th>${escapeXml(c)}</th>`).join('');
    const rows = items
        .map((item) => `<tr>${columns.map((c) => `<td>${escapeXml(scalar(item[c]))}</td>`).join('')}</tr>`)
        .join('\n');
    return `<!doctype html>
<meta charset="utf-8">
<style>
 body{font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:1.5rem}
 table{border-collapse:collapse;width:100%}
 th,td{border:1px solid #ddd;padding:.4rem .6rem;text-align:left;vertical-align:top}
 th{background:#f5f5f5}
</style>
<table><thead><tr>${head}</tr></thead><tbody>
${rows}
</tbody></table>
`;
}

/** Picks the field most like a title/link/date, so RSS is usable without configuration. */
function firstOf(item: Item, candidates: string[]): string | null {
    for (const key of candidates) {
        const value = item[key];
        if (typeof value === 'string' && value.trim() !== '') return value;
    }
    return null;
}

export function toRss(items: Item[], title = 'openactors dataset'): string {
    const entries = items
        .map((item) => {
            const itemTitle = firstOf(item, ['title', 'name', 'text']) ?? 'Untitled';
            const link = firstOf(item, ['url', 'applyUrl', 'mapsUrl', 'link']);
            const date = firstOf(item, ['postedAt', 'publishedAt', 'crawledAt', 'scrapedAt']);
            const description = firstOf(item, ['description', 'markdown', 'company', 'location']) ?? '';

            return [
                '    <item>',
                `      <title>${escapeXml(itemTitle)}</title>`,
                link ? `      <link>${escapeXml(link)}</link>` : '',
                link ? `      <guid isPermaLink="true">${escapeXml(link)}</guid>` : '',
                date ? `      <pubDate>${escapeXml(new Date(date).toUTCString())}</pubDate>` : '',
                `      <description>${escapeXml(description.slice(0, 500))}</description>`,
                '    </item>',
            ]
                .filter(Boolean)
                .join('\n');
        })
        .join('\n');

    return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>${escapeXml(title)}</title>
    <description>${escapeXml(title)}</description>
    <link>http://localhost/</link>
${entries}
  </channel>
</rss>
`;
}

export async function toXlsx(items: Item[], fields?: string[], sheetName = 'data'): Promise<Buffer> {
    // Imported lazily: it is the one heavyweight dependency here, and a server
    // that never exports a spreadsheet should not pay to load it.
    //
    // ExcelJS is CommonJS, so under NodeNext its exports arrive nested under
    // `default` rather than on the namespace — the same shape trap as Ajv.
    const imported = await import('exceljs');
    const ExcelJS = ((imported as unknown as { default?: unknown }).default ?? imported) as typeof imported;

    const workbook: Workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet(sheetName.slice(0, 31) || 'data');

    const columns = columnsOf(items, fields);
    sheet.addRow(columns);
    for (const item of items) sheet.addRow(columns.map((c) => scalar(item[c])));
    sheet.getRow(1).font = { bold: true };

    return Buffer.from(await workbook.xlsx.writeBuffer());
}

/** Renders items in the requested format, applying projection first. */
export async function exportItems(
    items: Item[],
    format: ExportFormat,
    options: ExportOptions = {},
): Promise<string | Buffer> {
    const projected = project(items, options);
    const fields = options.fields;

    switch (format) {
        case 'json':
            return `${JSON.stringify(projected, null, 2)}\n`;
        case 'jsonl':
            return projected.map((i) => JSON.stringify(i)).join('\n') + (projected.length > 0 ? '\n' : '');
        case 'csv':
            return toCsv(projected, fields);
        case 'xml':
            return toXml(projected);
        case 'html':
            return toHtml(projected, fields);
        case 'rss':
            return toRss(projected);
        case 'xlsx':
            return toXlsx(projected, fields);
    }
}
