import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const roles = JSON.parse(readFileSync(join(ROOT, 'roles.json'), 'utf8'));

/**
 * The nineteen job titles worth applying for, verbatim. Board and ATS feeds
 * are filtered on substrings, so a title that matches nothing is a role
 * silently never surfaced — invisible unless something checks.
 */
const QUALIFIED = [
    'Performance Marketing Manager',
    'Meta Ads Specialist',
    'Facebook Ads Specialist',
    'E-commerce Marketing Manager',
    'PPC Manager',
    'Paid Search Manager',
    'Growth Marketing Manager',
    'Digital Marketing Manager',
    'CRO Specialist (Conversion Rate Optimization Specialist)',
    'Paid Social Media Manager',
    'Shopify Developer',
    'Shopify Marketing Expert',
    'Media Buyer',
    'User Acquisition Manager',
    'Marketing Funnel Specialist',
    'Funnel Architect',
    'Lead Generation Specialist',
    'DTC Marketing Manager (Direct-to-Consumer)',
    'Retention & Lifecycle Marketing Manager',
    'Marketing Analytics Manager',
    'Full-Funnel Performance Marketer',
    'Paid Advertising Strategist',
    'E-commerce Growth Strategist',
];

const matched = (title: string) =>
    (roles.titleKeywords as string[]).filter((k) => title.toLowerCase().includes(k.toLowerCase()));

describe('title coverage', () => {
    it.each(QUALIFIED)('matches "%s"', (title) => {
        expect(matched(title), `no keyword matches "${title}"`).not.toHaveLength(0);
    });

    it('matches nothing in unrelated roles', () => {
        // Length is a poor proxy — "ppc" is three characters and perfectly
        // safe, while "ads" is three and matches "Roadside Assistance". What
        // matters is whether a keyword fires on work he would never apply for,
        // which is the failure that fills a digest with couriers and bakers.
        const UNRELATED = [
            'Roadside Assistance Advisor', 'Sandwich Artist', 'Retail Store Associate',
            'Baker - Day Shift', 'Overnight Task Team', 'Building Cleaner', 'CI001 Courier',
            'Quantity Surveyor', 'Assembly Technician', 'Front Office Executive',
            'Registered Nurse', 'Warehouse Operative', 'Security Officer',
            'Microphone Technician', 'Crop Scientist', 'Broadcast Engineer',
        ];

        for (const title of UNRELATED) {
            expect(matched(title), `"${title}" should not match any keyword`).toHaveLength(0);
        }
    });

    it('gives every LinkedIn query a matching title keyword', () => {
        // A query with no corresponding keyword means LinkedIn surfaces a role
        // that the board and ATS searches would then throw away.
        for (const q of roles.linkedinQueries as string[]) {
            expect(matched(q), `LinkedIn query "${q}" has no title keyword`).not.toHaveLength(0);
        }
    });
});
