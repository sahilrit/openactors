import { describe, expect, it } from 'vitest';
import { parseIntParam } from '../src/rest.js';
import { parsePostPage, resolvePostUrl } from '../src/linkedin-post.js';

describe('parseIntParam', () => {
    // Regression: Number(null) is 0, not NaN, so an absent parameter used to
    // clamp to `min` instead of falling back. Every unspecified `limit` became 1
    // and every unspecified `timeout` became 5 seconds.
    it('falls back when the parameter is absent', () => {
        expect(parseIntParam(null, 1000, 1, 100_000)).toBe(1000);
        expect(parseIntParam(null, 300, 5, 3600)).toBe(300);
    });

    it('falls back on an empty or whitespace value', () => {
        expect(parseIntParam('', 1000, 1, 100_000)).toBe(1000);
        expect(parseIntParam('   ', 1000, 1, 100_000)).toBe(1000);
    });

    it('falls back on a non-numeric value', () => {
        expect(parseIntParam('abc', 50, 1, 500)).toBe(50);
    });

    it('honours an explicit zero rather than treating it as absent', () => {
        expect(parseIntParam('0', 60, 0, 600)).toBe(0);
    });

    it('clamps to the allowed range and truncates', () => {
        expect(parseIntParam('999999', 1000, 1, 100_000)).toBe(100_000);
        expect(parseIntParam('-5', 1000, 1, 100_000)).toBe(1);
        expect(parseIntParam('12.9', 1000, 1, 100_000)).toBe(12);
    });
});

describe('resolvePostUrl', () => {
    it('passes a full URL through untouched', () => {
        const url = 'https://www.linkedin.com/posts/someone_x-activity-7236288582401884162-ab12';
        expect(resolvePostUrl(url)).toBe(url);
    });

    it('turns a bare id or urn into the /feed/update/ form that renders logged out', () => {
        const expected = 'https://www.linkedin.com/feed/update/urn:li:activity:7236288582401884162/';
        expect(resolvePostUrl('7236288582401884162')).toBe(expected);
        expect(resolvePostUrl('urn:li:activity:7236288582401884162')).toBe(expected);
    });

    it('rejects input with no id in it', () => {
        expect(() => resolvePostUrl('not-a-post')).toThrow(/activity id/);
        expect(() => resolvePostUrl('')).toThrow(/required/);
    });
});

const page = (payload: unknown) =>
    `<html><head><script type="application/ld+json">${JSON.stringify(payload)}</script></head></html>`;

describe('parsePostPage', () => {
    const sample = {
        '@id': 'https://www.linkedin.com/posts/someone_x-activity-7236288582401884162-ab12',
        datePublished: '2024-09-02T10:00:00.000Z',
        headline: 'A headline',
        articleBody: 'The body of the post.',
        commentCount: 2,
        author: { name: 'Sahil Sachdeva', url: 'https://www.linkedin.com/in/sahilrit' },
        interactionStatistic: [
            { interactionType: 'http://schema.org/LikeAction', userInteractionCount: 7 },
        ],
        comment: [
            {
                text: 'Nice one',
                datePublished: '2024-09-02T11:00:00.000Z',
                author: { name: 'Someone Else' },
                interactionStatistic: { interactionType: 'http://schema.org/LikeAction', userInteractionCount: 1 },
            },
        ],
        image: [{ url: 'https://media.licdn.com/one.jpg' }],
    };

    it('pulls out body, author, counts and comments', () => {
        const post = parsePostPage(page(sample), sample['@id']);
        expect(post.text).toBe('The body of the post.');
        expect(post.authorName).toBe('Sahil Sachdeva');
        expect(post.totalReactions).toBe(7);
        expect(post.commentCount).toBe(2);
        expect(post.activityId).toBe('7236288582401884162');
        expect(post.images).toEqual(['https://media.licdn.com/one.jpg']);
        expect(post.comments).toEqual([
            { text: 'Nice one', authorName: 'Someone Else', createdAt: '2024-09-02T11:00:00.000Z', likes: 1 },
        ]);
    });

    it('reports a login-walled or removed post rather than returning a shell', () => {
        expect(() => parsePostPage('<html><body>nothing here</body></html>', 'https://x')).toThrow(
            /private, removed, or login-walled/,
        );
    });

    it('treats a post with no comments as an empty thread, not a failure', () => {
        const post = parsePostPage(page({ ...sample, comment: [], commentCount: 0 }), sample['@id']);
        expect(post.comments).toEqual([]);
        expect(post.commentCount).toBe(0);
    });
});
