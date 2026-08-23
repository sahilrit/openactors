import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PROJECT_ROOT } from './paths.js';

/**
 * The console lives in `public/console.html` rather than inside a template
 * literal here: its own JavaScript uses backticks, which would terminate the
 * enclosing string, and escaping them by hand is exactly the kind of thing
 * that breaks silently on the next edit.
 *
 * Read once and cached — it is static, and re-reading it per request would put
 * a file system call in the path of every page load for no benefit.
 */
let cached: string | null = null;

export async function consoleHtml(): Promise<string> {
    if (cached) return cached;
    // Source checkout first, then a build that carries its own copy.
    for (const candidate of [join(PROJECT_ROOT, 'public', 'console.html'), join(PROJECT_ROOT, 'dist', 'public', 'console.html')]) {
        cached = await readFile(candidate, 'utf8').catch(() => null);
        if (cached) return cached;
    }

    try {
        throw new Error('public/console.html not found');
    } catch (err) {
        // A missing console must not take the API down with it.
        cached = `<!doctype html><meta charset="utf-8"><title>openactors</title>
<p style="font:14px sans-serif;padding:2rem">Console asset is missing (${(err as Error).message}).
The REST API at <code>/v2</code> and MCP at <code>/mcp</code> are unaffected.</p>`;
    }
    return cached;
}
