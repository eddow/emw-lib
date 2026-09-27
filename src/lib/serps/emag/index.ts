import type { FetchFn, ListEntry, Paginator, ScraperAdapter } from '../types.js';
import { parseEmagMaxPages, parseEmagSearchPage } from './parse.js';

/** eMAG country site. Base URL differs per locale; markup is shared. */
export type EmagLocale = 'ro' | 'bg' | 'hu';

const BASES: Record<EmagLocale, string> = {
	ro: 'https://www.emag.ro',
	bg: 'https://www.emag.bg',
	hu: 'https://www.emag.hu'
};
const UA =
	'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

/** Build the eMAG search URL for `terms`, 1-based `page` and `locale`. */
export function emagSearchUrl(terms: string, page = 1, locale: EmagLocale = 'ro'): string {
	const q = encodeURIComponent(terms.trim()).replace(/%20/g, '+');
	const base = `${BASES[locale]}/search/${q}`;
	return page > 1 ? `${base}/p${page}` : base;
}

async function fetchHtml(url: string, fetchFn: FetchFn): Promise<string> {
	const res = await fetchFn(url, { headers: { 'user-agent': UA } });
	if (!res.ok) throw new Error(`emag search failed: ${res.status} ${res.statusText} (${url})`);
	return await res.text();
}

class EmagPaginator implements Paginator {
	maxPages: number = NaN;
	private maxPagesResolved = false;

	constructor(
		private terms: string,
		private fetchFn: FetchFn,
		private locale: EmagLocale
	) {}

	async page(n: number): Promise<ListEntry[]> {
		if (!Number.isInteger(n) || n < 1) throw new RangeError(`emag.${this.locale}: page must be >= 1, got ${n}`);
		if (!Number.isNaN(this.maxPages) && n > this.maxPages)
			throw new RangeError(`emag.${this.locale}: page ${n} exceeds maxPages ${this.maxPages}`);
		const html = await fetchHtml(emagSearchUrl(this.terms, n, this.locale), this.fetchFn);
		if (!this.maxPagesResolved) {
			this.maxPages = parseEmagMaxPages(html);
			this.maxPagesResolved = true;
		}
		return parseEmagSearchPage(html);
	}
}

export function createEmagAdapter(fetchFn: FetchFn = fetch, locale: EmagLocale = 'ro'): ScraperAdapter {
	return {
		name: `emag.${locale}`,
		async search(terms: string): Promise<Paginator> {
			if (!terms.trim()) throw new Error(`emag.${locale}: search terms must not be empty`);
			const paginator = new EmagPaginator(terms, fetchFn, locale);
			// Resolve maxPages eagerly from the first page fetch is lazy:
			// callers read `maxPages` after the first `page()` call.
			return paginator;
		}
	};
}

/** Per-country adapters sharing the eMAG parser: `emag.ro` / `emag.bg` / `emag.hu`. */
export const emag: Record<EmagLocale, ScraperAdapter> = {
	ro: createEmagAdapter(fetch, 'ro'),
	bg: createEmagAdapter(fetch, 'bg'),
	hu: createEmagAdapter(fetch, 'hu')
};
