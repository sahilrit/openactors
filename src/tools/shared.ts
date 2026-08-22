/**
 * Response helpers shared by the tool modules.
 *
 * The budget matters: a tool result goes straight into an agent's context, and
 * a single crawled page can be tens of thousands of characters. Tools return a
 * bounded preview and tell the caller how to page for the rest.
 */
export const INLINE_CHAR_BUDGET = 20_000;

export function text(payload: unknown) {
    const body = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
    return { content: [{ type: 'text' as const, text: body }] };
}

export function fail(message: string) {
    return { content: [{ type: 'text' as const, text: message }], isError: true };
}

/** Trims a list to fit the inline budget, reporting how many were withheld. */
export function previewItems(items: unknown[]): { shown: unknown[]; truncated: number } {
    const shown: unknown[] = [];
    let used = 0;
    for (const item of items) {
        const size = JSON.stringify(item)?.length ?? 0;
        if (used + size > INLINE_CHAR_BUDGET && shown.length > 0) break;
        shown.push(item);
        used += size;
    }
    return { shown, truncated: items.length - shown.length };
}
