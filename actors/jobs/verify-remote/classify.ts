/**
 * Decides what a job posting actually says about where the work happens.
 *
 * Every posting reaching this has already been tagged remote by LinkedIn's own
 * filter, and that tag is demonstrably loose — a role titled "Full time
 * on-site" came through it. So the job here is to find text that *contradicts*
 * the tag, which means a phrase like "hybrid" has to outrank a passing mention
 * of the word "remote". Ranked the other way, almost everything reads as remote
 * and the check is worthless.
 */

export type WorkplaceVerdict = 'remote' | 'hybrid' | 'onsite' | 'unclear';

export interface WorkplaceAssessment {
    verdict: WorkplaceVerdict;
    /** The phrase the verdict rests on, so it can be checked rather than trusted. */
    evidence: string;
}

/**
 * Marketing vocabulary that borrows the same words.
 *
 * "on-site SEO" and "on-page optimisation" are craft terms, not workplace
 * arrangements — and this tool is pointed squarely at marketing roles, so
 * reading them literally would mark remote jobs as office-based more often
 * than not.
 */
const DOMAIN_TERMS =
    /\b(?:on[-\s]?site|onsite)\s+(?:seo|optimi[sz]ation|content|search|experience|conversion|analytics|engagement|activation|events?|signals?)\b/gi;

/**
 * A denial of an arrangement means the opposite of the arrangement.
 *
 * "NO Hybrid model / NO Work from home" describes an office job, and taking
 * the words at face value inverts the answer entirely.
 */
const NEGATED =
    /\b(?:no|not|non|without|never)\s+(?:a\s+|any\s+)?(?:hybrid|remote|work\s+from\s+home|wfh)\b/gi;

/** Ordered most restrictive first: the first match wins. */
const PATTERNS: Array<{ verdict: WorkplaceVerdict; pattern: RegExp }> = [
    { verdict: 'hybrid', pattern: /\bhybrid\b/i },
    // A place name commonly sits between: "work from our Gurugram office".
    { verdict: 'onsite', pattern: /\b(?:work|working)\s+from\s+(?:the\s+|our\s+)?(?:[A-Za-z]+\s+){0,2}office\b/i },
    { verdict: 'onsite', pattern: /\bwfo\b/i },
    { verdict: 'onsite', pattern: /\b(?:in[-\s]office|on[-\s]site|onsite)\b/i },
    { verdict: 'onsite', pattern: /\b(?:willing\s+to\s+)?relocat(?:e|ion)\b/i },
    { verdict: 'onsite', pattern: /\bmust\s+be\s+(?:based|located)\s+(?:in|at|out\s+of)\b/i },
    { verdict: 'onsite', pattern: /\bdays?\s+(?:a\s+week\s+)?(?:from|in)\s+(?:the\s+|our\s+)?office\b/i },
    { verdict: 'remote', pattern: /\b(?:fully|100%|completely|entirely)\s+remote\b/i },
    { verdict: 'remote', pattern: /\bremote[-\s]first\b/i },
    { verdict: 'remote', pattern: /\bwork\s+from\s+home\b/i },
    { verdict: 'remote', pattern: /\bwfh\b/i },
    { verdict: 'remote', pattern: /\bwork\s+from\s+anywhere\b/i },
    { verdict: 'remote', pattern: /\bremote\s+(?:role|position|opportunity|job)\b/i },
];

/** A short window around the match, enough to judge it without reprinting the posting. */
function quote(text: string, index: number, length: number): string {
    const start = Math.max(0, index - 60);
    const end = Math.min(text.length, index + length + 60);
    return `${start > 0 ? '…' : ''}${text.slice(start, end).replace(/\s+/g, ' ').trim()}${end < text.length ? '…' : ''}`;
}

export function classifyWorkplace(description: string): WorkplaceAssessment {
    const original = (description ?? '').replace(/\s+/g, ' ');
    if (original.trim() === '') return { verdict: 'unclear', evidence: '' };

    // A denied arrangement settles the question before anything else is read.
    const denial = new RegExp(NEGATED.source, 'i').exec(original);
    if (denial) {
        return { verdict: 'onsite', evidence: quote(original, denial.index, denial[0].length) };
    }

    // Craft terms are blanked rather than removed, so match offsets still point
    // into the original text and the quoted evidence stays truthful.
    const text = original.replace(DOMAIN_TERMS, (m) => ' '.repeat(m.length));

    for (const { verdict, pattern } of PATTERNS) {
        const match = pattern.exec(text);
        if (match) return { verdict, evidence: quote(original, match.index, match[0].length) };
    }

    return { verdict: 'unclear', evidence: '' };
}
