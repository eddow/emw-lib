import type { FetchFn, ListEntry, Paginator, ScraperAdapter } from '../types.js'
import { parseAosomMaxPages, parseAosomSearchPage } from './parse.js'

const BASE = 'https://www.aosom.ro'
const UA =
	'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'

/**
 * Build the Aosom keyword-search URL for `terms` and 1-based `page`.
 * Pattern observed in the browser: `/k/<terms>.html?page=N` (page 1 has no param).
 */
export function aosomSearchUrl(terms: string, page = 1): string {
	const q = encodeURIComponent(terms.trim().toLowerCase()).replace(/%20/g, '+')
	const base = `${BASE}/k/${q}.html`
	return page > 1 ? `${base}?page=${page}` : base
}

async function fetchHtml(url: string, fetchFn: FetchFn): Promise<string> {
	const res = await fetchFn(url, { headers: { 'user-agent': UA } })
	if (!res.ok) throw new Error(`aosom search failed: ${res.status} ${res.statusText} (${url})`)
	return await res.text()
}

class AosomPaginator implements Paginator {
	maxPages: number = NaN
	private maxPagesResolved = false

	constructor(
		private terms: string,
		private fetchFn: FetchFn
	) {}

	async page(n: number): Promise<ListEntry[]> {
		if (!Number.isInteger(n) || n < 1) throw new RangeError(`aosom: page must be >= 1, got ${n}`)
		if (!Number.isNaN(this.maxPages) && n > this.maxPages)
			throw new RangeError(`aosom: page ${n} exceeds maxPages ${this.maxPages}`)
		const html = await fetchHtml(aosomSearchUrl(this.terms, n), this.fetchFn)
		if (!this.maxPagesResolved) {
			this.maxPages = parseAosomMaxPages(html)
			this.maxPagesResolved = true
		}
		return parseAosomSearchPage(html)
	}
}

export function createAosomAdapter(fetchFn: FetchFn = fetch): ScraperAdapter {
	return {
		name: 'aosom',
		async search(terms: string): Promise<Paginator> {
			if (!terms.trim()) throw new Error('aosom: search terms must not be empty')
			return new AosomPaginator(terms, fetchFn)
		},
	}
}

/** Default adapter using the global fetch. */
export const aosom: ScraperAdapter = createAosomAdapter()
