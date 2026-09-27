import type { ListEntry } from '../types.js';

/**
 * Parse eMAG search-result HTML into list entries.
 *
 * Each product card is a `.js-product-data[data-product-id]` element carrying
 * `data-name`, `data-url`, `data-product-id`, `data-offer-id`, `data-category-*`
 * attributes. Price / rating / thumbnail are read from the card body.
 */
export function parseEmagSearchPage(html: string): ListEntry[] {
	const cards = splitCards(html);
	const entries: ListEntry[] = [];
	for (const card of cards) {
		const entry = parseCard(card);
		if (entry) entries.push(entry);
	}
	return entries;
}

/**
 * Extract the total page count from eMAG search HTML.
 * The mobile paginator renders `1 din 49`; desktop renders `data-page` links.
 * Returns `NaN` when no pagination info is found (single page / unknown).
 */
export function parseEmagMaxPages(html: string): number {
	const din = html.match(/(\d+)\s+din\s+(\d+)/);
	if (din) {
		const total = parseInt(din[2], 10);
		if (Number.isFinite(total) && total > 0) return total;
	}
	let max = 0;
	for (const m of html.matchAll(/data-page="(\d+)"/g)) {
		const n = parseInt(m[1], 10);
		if (Number.isFinite(n) && n > max) max = n;
	}
	if (max > 0) return max;
	return NaN;
}

function splitCards(html: string): string[] {
	const out: string[] = [];
	const re = /<div[^>]*class="[^"]*js-product-data[^"]*"[^>]*data-product-id="[^"]+"[^>]*>/g;
	const starts: Array<{ index: number; tag: string }> = [];
	let m: RegExpExecArray | null;
	while ((m = re.exec(html)) !== null) starts.push({ index: m.index, tag: m[0] });
	for (let i = 0; i < starts.length; i++) {
		const end = i + 1 < starts.length ? starts[i + 1].index : html.length;
		out.push(html.slice(starts[i].index, end));
	}
	return out;
}

function parseCard(card: string): ListEntry | null {
	const id = attr(card, 'data-product-id');
	const title = decodeEntities(attr(card, 'data-name'));
	const url = attr(card, 'data-url');
	if (!id || !title || !url) return null;

	const entry: ListEntry = { title, id, url };

	const offerId = attr(card, 'data-offer-id');
	if (offerId) entry.offerId = offerId;
	const category = attr(card, 'data-category-name');
	if (category) entry.category = decodeEntities(category);
	const categoryTrail = attr(card, 'data-category-trail');
	if (categoryTrail) entry.categoryTrail = decodeEntities(categoryTrail);
	const position = attr(card, 'data-position');
	if (position) {
		const n = parseInt(position, 10);
		if (Number.isFinite(n)) entry.position = n;
	}

	const price = parsePrice(card);
	if (price !== null) {
		entry.price = price.value;
		entry.currency = price.currency;
		if (price.oldValue !== null) entry.oldPrice = price.oldValue;
	}

	const rating = card.match(/class="average-rating[^"]*"[^>]*>([^<]+)</);
	if (rating) {
		const v = parseFloat(rating[1].replace(',', '.'));
		if (Number.isFinite(v)) entry.rating = v;
	}
	const reviews = card.match(/(\d[\d\s.]*)\s+de\s+review-uri/);
	if (reviews) {
		const v = parseInt(reviews[1].replace(/[\s.]/g, ''), 10);
		if (Number.isFinite(v)) entry.reviews = v;
	}

	const img = card.match(/<img[^>]*src="([^"]+)"[^>]*alt="[^"]*"/) ?? card.match(/data-img="([^"]+)"/);
	if (img) entry.thumbnail = decodeEntities(img[1]);

	const availability = card.match(/text-availability-[a-z_]+">\s*([^<]+?)\s*</);
	if (availability) entry.availability = decodeEntities(availability[1].trim());

	return entry;
}

function attr(tag: string, name: string): string {
	const m = tag.match(new RegExp(name + '="([^"]*)"'));
	return m ? m[1] : '';
}

function decodeEntities(s: string): string {
	return s
		.replace(/&amp;/g, '&')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>');
}

function parsePrice(card: string): { value: number; currency: string; oldValue: number | null } | null {
	const m = card.match(
		/class="product-new-price"[^>]*>\s*([\d.,\s]+)<sup>.*?<small[^>]*>([^<]*)<\/small>([^<]*)<\/sup>\s*<span>([^<]*)<\/span>/
	);
	if (!m) return null;
	const intPart = m[1].replace(/[\s.]/g, '').replace(',', '.');
	const frac = (m[3] ?? '').replace(/\D/g, '');
	const value = parseFloat(frac ? `${intPart}.${frac}` : intPart);
	if (!Number.isFinite(value)) return null;
	const currency = decodeEntities((m[4] ?? '').trim()) || 'Lei';

	let oldValue: number | null = null;
	const old = card.match(/<s>\s*([\d.,\s]+)<sup>.*?<small[^>]*>([^<]*)<\/small>([^<]*)<\/sup>/);
	if (old) {
		const oi = old[1].replace(/[\s.]/g, '').replace(',', '.');
		const of = (old[3] ?? '').replace(/\D/g, '');
		const v = parseFloat(of ? `${oi}.${of}` : oi);
		if (Number.isFinite(v)) oldValue = v;
	}
	return { value, currency, oldValue };
}
