/**
 * Turns one Google Maps result card into a record.
 *
 * Parsing is done on the card's rendered text rather than its DOM, because
 * every class name in a Maps card is build-generated (`W4Efsd`, `xxVWCe`) and
 * rotates without notice. The visible text is what Google actually commits to
 * showing a user, and it has held its shape far longer than the markup.
 *
 * A card's lines look like:
 *   [0] Reliant Plumbing
 *   [1] Reliant Plumbing
 *   [2] 4.7(2,930)
 *   [3] Plumber · 3705 San Antonio St
 *   [4] Open 24 hours · +1 512-222-6029
 *
 * Nothing here assumes a fixed line index: each field is found by shape, so a
 * card missing a rating or an address yields nulls rather than shifted values.
 */

export interface MapsBusiness {
    name: string | null;
    rating: number | null;
    reviews: number | null;
    category: string | null;
    address: string | null;
    phone: string | null;
    hours: string | null;
    hasWebsite: boolean;
    mapsUrl: string;
    website: string | null;
}

/** e.g. "4.7(2,930)" or "4.7 (2,930)" — also matches a rating with no reviews. */
const RATING = /^([0-5](?:[.,]\d)?)\s*(?:\(([\d,.]+)\))?$/;
/** Deliberately strict: seven or more digits, so street numbers don't match. */
const PHONE = /(\+?\d[\d\s().\-]{7,}\d)/;

export function parseCard(aria: string | null, rawLines: string[], mapsUrl: string): MapsBusiness {
    const lines = rawLines.map((l) => l.trim()).filter((l) => l.length > 0);

    const name = aria?.trim() || lines[0] || null;

    let rating: number | null = null;
    let reviews: number | null = null;
    let ratingIndex = -1;
    for (const [i, line] of lines.entries()) {
        const match = line.match(RATING);
        if (!match) continue;
        rating = Number(match[1].replace(',', '.'));
        reviews = match[2] ? Number(match[2].replace(/[,.]/g, '')) : null;
        ratingIndex = i;
        break;
    }

    // Google renders the review count inconsistently: sometimes joined to the
    // rating ("4.9(2,565)"), sometimes on its own line, and sometimes omitted
    // from the card entirely. Absent means null, not zero.
    if (rating !== null && reviews === null) {
        const next = lines[ratingIndex + 1]?.match(/^\(?([\d,.]+)\)$/);
        if (next) reviews = Number(next[1].replace(/[,.]/g, ''));
    }

    // The descriptor line sits after the rating. It is usually
    // "Category · Address", but a listing with no street address renders the
    // category alone — which must still yield a category rather than nothing.
    //
    // Scanning starts after the rating; with no rating on the card it starts
    // after the name instead. Starting at index 0 would take the business name
    // itself as the category.
    let category: string | null = null;
    let address: string | null = null;
    const descriptorStart =
        ratingIndex >= 0 ? ratingIndex + 1 : lines.findIndex((line) => line !== name) + 1 || lines.length;

    for (const line of lines.slice(descriptorStart)) {
        if (line === name) continue; // Maps repeats the name in the card
        if (PHONE.test(line)) break; // reached the hours/phone line
        if (/^\(?[\d,.]+\)?$/.test(line)) continue; // a stray review count
        if (line === 'Website' || line === 'Directions') break;

        const parts = line.split('·').map((part) => part.trim()).filter(Boolean);
        category = parts[0] ?? null;
        address = parts.length > 1 ? parts[parts.length - 1] : null;
        break;
    }

    const phoneLine = lines.find((l) => PHONE.test(l));
    const phone = phoneLine?.match(PHONE)?.[1]?.trim() ?? null;

    // Hours share the phone's line, ahead of the number.
    let hours: string | null = null;
    if (phoneLine) {
        const before = phoneLine.split('·').map((p) => p.trim()).filter((p) => p && !PHONE.test(p));
        hours = before.length > 0 ? before.join(' · ') : null;
    }

    return {
        name,
        rating,
        reviews,
        category,
        address,
        phone,
        hours,
        // The card renders a "Website" affordance only when one is listed; the
        // URL itself needs the listing opened.
        hasWebsite: lines.includes('Website'),
        mapsUrl,
        website: null,
    };
}
