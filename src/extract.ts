import { Readability } from '@mozilla/readability';
import { JSDOM, VirtualConsole } from 'jsdom';
import TurndownService from 'turndown';

const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
// Keep the text, drop the chrome. These never carry article content.
turndown.remove(['script', 'style', 'nav', 'footer', 'noscript', 'iframe', 'form']);

/**
 * Extracts the main article from a page and converts it to Markdown.
 *
 * Readability is the engine behind Firefox Reader Mode: it scores DOM nodes by
 * text density to find the content well, which removes navigation and sidebars
 * without per-site rules. When it finds nothing article-shaped (a link hub, a
 * landing page) we fall back to the whole body rather than returning nothing.
 */
export function htmlToMarkdown(html: string, url: string): { title: string; markdown: string } {
    // jsdom logs every CSS parse error on real-world pages. On an MCP server
    // that noise would land on stderr, so it is silenced explicitly.
    const virtualConsole = new VirtualConsole();
    const dom = new JSDOM(html, { url, virtualConsole });

    let title = dom.window.document.title ?? '';
    let contentHtml: string;

    try {
        const article = new Readability(dom.window.document.cloneNode(true) as Document).parse();
        if (article?.content && article.content.length > 200) {
            contentHtml = article.content;
            title = article.title || title;
        } else {
            contentHtml = dom.window.document.body?.innerHTML ?? '';
        }
    } catch {
        contentHtml = dom.window.document.body?.innerHTML ?? '';
    }

    const markdown = turndown
        .turndown(contentHtml)
        .replace(/\n{3,}/g, '\n\n')
        .trim();

    return { title: title.trim(), markdown };
}
