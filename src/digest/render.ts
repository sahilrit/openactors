export interface SearchResult {
    name: string;
    actor: string;
    fresh: Record<string, unknown>[];
    repeatCount: number;
    firstRun: boolean;
    display: string[];
    error?: string;
}

/** Field order tried when a search does not declare `display`. */
const PREFERRED = ['title', 'company', 'account', 'location', 'workplaceType', 'eligibility', 'postedAt', 'publishedAt', 'name', 'rating', 'phone'];

export function inferDisplay(items: Record<string, unknown>[]): string[] {
    if (items.length === 0) return [];
    const present = new Set(Object.keys(items[0]));
    const chosen = PREFERRED.filter((f) => present.has(f));
    return chosen.length > 0 ? chosen : [...present].slice(0, 4);
}

function value(item: Record<string, unknown>, field: string): string {
    const raw = item[field];
    if (raw === null || raw === undefined || raw === '') return '—';
    // Dates are the only values worth reshaping; everything else reads better raw.
    if (typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(raw)) return raw.slice(0, 10);
    return String(raw);
}

function linkOf(item: Record<string, unknown>): string | null {
    for (const field of ['url', 'applyUrl', 'mapsUrl']) {
        const raw = item[field];
        if (typeof raw === 'string' && /^https?:\/\//.test(raw)) return raw;
    }
    return null;
}

export function renderMarkdown(results: SearchResult[], now: Date): string {
    const total = results.reduce((sum, r) => sum + r.fresh.length, 0);
    const date = now.toISOString().slice(0, 10);

    const lines: string[] = [`# Digest — ${date}`, ''];

    if (total === 0) {
        lines.push('Nothing new since the last run.', '');
    } else {
        lines.push(`**${total} new** across ${results.filter((r) => r.fresh.length > 0).length} search(es).`, '');
    }

    for (const result of results) {
        lines.push(`## ${result.name}`, '');

        if (result.error) {
            lines.push(`> Failed: ${result.error}`, '');
            continue;
        }
        if (result.firstRun) {
            lines.push(`_First run — everything below is new because there is no history to compare against._`, '');
        }
        if (result.fresh.length === 0) {
            lines.push(`Nothing new. ${result.repeatCount} already-seen result(s).`, '');
            continue;
        }

        const fields = result.display.length > 0 ? result.display : inferDisplay(result.fresh);
        lines.push(`${result.fresh.length} new · ${result.repeatCount} already seen`, '');
        lines.push(`| ${fields.join(' | ')} |`, `|${fields.map(() => '---').join('|')}|`);

        for (const item of result.fresh) {
            const cells = fields.map((field, index) => {
                const text = value(item, field).replace(/\|/g, '\\|');
                const link = index === 0 ? linkOf(item) : null;
                return link ? `[${text}](${link})` : text;
            });
            lines.push(`| ${cells.join(' | ')} |`);
        }
        lines.push('');
    }

    return lines.join('\n');
}

export function renderHtml(results: SearchResult[], now: Date): string {
    const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
    const total = results.reduce((sum, r) => sum + r.fresh.length, 0);
    const date = now.toISOString().slice(0, 10);

    const sections = results
        .map((result) => {
            if (result.error) {
                return `<section><h2>${esc(result.name)}</h2><p class="err">Failed: ${esc(result.error)}</p></section>`;
            }
            if (result.fresh.length === 0) {
                return `<section><h2>${esc(result.name)}</h2><p class="muted">Nothing new · ${result.repeatCount} already seen</p></section>`;
            }

            const fields = result.display.length > 0 ? result.display : inferDisplay(result.fresh);
            const head = fields.map((f) => `<th>${esc(f)}</th>`).join('');
            const rows = result.fresh
                .map((item) => {
                    const cells = fields.map((field, index) => {
                        const text = esc(value(item, field));
                        const link = index === 0 ? linkOf(item) : null;
                        return `<td>${link ? `<a href="${esc(link)}">${text}</a>` : text}</td>`;
                    });
                    return `<tr>${cells.join('')}</tr>`;
                })
                .join('');

            return `<section><h2>${esc(result.name)}</h2>
<p class="muted">${result.fresh.length} new · ${result.repeatCount} already seen${result.firstRun ? ' · first run, no history to compare against' : ''}</p>
<div class="scroll"><table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div></section>`;
        })
        .join('\n');

    return `<title>Digest ${date}</title>
<style>
  :root { --bg:#fff; --fg:#111; --muted:#666; --line:#e5e5e5; --link:#0b5fff; --err:#b00020; }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) { --bg:#111; --fg:#eee; --muted:#999; --line:#333; --link:#7aa2ff; --err:#ff6b81; }
  }
  :root[data-theme="dark"] { --bg:#111; --fg:#eee; --muted:#999; --line:#333; --link:#7aa2ff; --err:#ff6b81; }
  body { background:var(--bg); color:var(--fg); font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
         margin:0 auto; padding:2rem 1.25rem; max-width:70rem; }
  h1 { font-size:1.5rem; margin:0 0 .25rem; }
  h2 { font-size:1.05rem; margin:2rem 0 .4rem; }
  .muted { color:var(--muted); font-size:.86rem; margin:.2rem 0 .6rem; }
  .err { color:var(--err); }
  .scroll { overflow-x:auto; }
  table { border-collapse:collapse; width:100%; font-size:.9rem; }
  th,td { text-align:left; padding:.45rem .6rem; border-bottom:1px solid var(--line); vertical-align:top; }
  th { color:var(--muted); font-weight:600; white-space:nowrap; }
  a { color:var(--link); }
</style>
<h1>Digest — ${date}</h1>
<p class="muted">${total === 0 ? 'Nothing new since the last run.' : `${total} new result(s)`}</p>
${sections}`;
}
