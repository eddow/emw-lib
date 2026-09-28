import type { FetchFn, ListEntry, Paginator, ScraperAdapter } from '../types.js'
import { parseEuropagesDetails, parseEuropagesMaxPages, parseEuropagesSearchPage } from './parse.js'

const BASE = 'https://www.europages.fr'
const UA =
	'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'

/**
 * Build the Europages company-search URL for `terms` and 1-based `page`.
 * Page 1 is `/entreprises/<terms>.html`; later pages use the `pg-N` segment:
 * `/entreprises/pg-2/<terms>.html`.
 */
export function europagesSearchUrl(terms: string, page = 1): string {
	const q = encodeURIComponent(terms.trim().toLowerCase()).replace(/%20/g, '-')
	const base =
		page > 1 ? `${BASE}/entreprises/pg-${page}/${q}.html` : `${BASE}/entreprises/${q}.html`
	return base
}

async function fetchHtml(url: string, fetchFn: FetchFn): Promise<string> {
	const res = await fetchFn(url, { headers: { 'user-agent': UA } })
	if (!res.ok) throw new Error(`europages search failed: ${res.status} ${res.statusText} (${url})`)
	return await res.text()
}

class EuropagesPaginator implements Paginator {
	maxPages: number = NaN
	private maxPagesResolved = false

	constructor(
		private terms: string,
		private fetchFn: FetchFn
	) {}

	async page(n: number): Promise<ListEntry[]> {
		if (!Number.isInteger(n) || n < 1)
			throw new RangeError(`europages: page must be >= 1, got ${n}`)
		if (!Number.isNaN(this.maxPages) && n > this.maxPages)
			throw new RangeError(`europages: page ${n} exceeds maxPages ${this.maxPages}`)
		const html = await fetchHtml(europagesSearchUrl(this.terms, n), this.fetchFn)
		if (!this.maxPagesResolved) {
			this.maxPages = parseEuropagesMaxPages(html)
			this.maxPagesResolved = true
		}
		return parseEuropagesSearchPage(html)
	}
}

export function createEuropagesAdapter(fetchFn: FetchFn = fetch): ScraperAdapter {
	return {
		name: 'europages',
		async search(terms: string): Promise<Paginator> {
			if (!terms.trim()) throw new Error('europages: search terms must not be empty')
			return new EuropagesPaginator(terms, fetchFn)
		},
		async details(id: string): Promise<Record<string, unknown>> {
			// id is the numeric company id; the slug is unknown so resolve via search is out
			// of scope — details() accepts either the id or a full company URL.
			const url = id.startsWith('http') ? id : `${BASE}/fr/company/a-${id.trim()}`
			const html = await fetchHtml(url, fetchFn)
			return parseEuropagesDetails(html, url)
		},
	}
}

/** Default adapter using the global fetch. */
export const europages: ScraperAdapter = createEuropagesAdapter()
