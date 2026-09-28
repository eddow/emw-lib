import type { FetchFn, ListEntry, Paginator, ScraperAdapter } from '../types.js'
import { parseKompassDetails, parseKompassMaxPages, parseKompassSearchPage } from './parse.js'

const BASE = 'https://fr.kompass.com'
const UA =
	'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'

/**
 * Build the Kompass company-search URL for `terms` and 1-based `page`.
 * Search is product-keyword based (`searchType=PRODUCT`); company results
 * come from the `tab=cmp` pager (`/searchCompanies/scroll?tab=cmp&pageNbre=N`).
 * Page 1 is the bare search URL; later pages use the scroll endpoint.
 */
export function kompassSearchUrl(terms: string, page = 1): string {
	const q = encodeURIComponent(terms.trim()).replace(/%20/g, '+')
	if (page > 1) return `${BASE}/searchCompanies/scroll?tab=cmp&pageNbre=${page}&text=${q}`
	return `${BASE}/searchCompanies?searchType=PRODUCT&text=${q}`
}

async function fetchHtml(url: string, fetchFn: FetchFn): Promise<string> {
	const res = await fetchFn(url, { headers: { 'user-agent': UA } })
	if (!res.ok) throw new Error(`kompass search failed: ${res.status} ${res.statusText} (${url})`)
	return await res.text()
}

class KompassPaginator implements Paginator {
	maxPages: number = NaN
	private maxPagesResolved = false

	constructor(
		private terms: string,
		private fetchFn: FetchFn
	) {}

	async page(n: number): Promise<ListEntry[]> {
		if (!Number.isInteger(n) || n < 1) throw new RangeError(`kompass: page must be >= 1, got ${n}`)
		if (!Number.isNaN(this.maxPages) && n > this.maxPages)
			throw new RangeError(`kompass: page ${n} exceeds maxPages ${this.maxPages}`)
		const html = await fetchHtml(kompassSearchUrl(this.terms, n), this.fetchFn)
		if (!this.maxPagesResolved) {
			this.maxPages = parseKompassMaxPages(html)
			this.maxPagesResolved = true
		}
		return parseKompassSearchPage(html)
	}
}

export function createKompassAdapter(fetchFn: FetchFn = fetch): ScraperAdapter {
	return {
		name: 'kompass',
		async search(terms: string): Promise<Paginator> {
			if (!terms.trim()) throw new Error('kompass: search terms must not be empty')
			return new KompassPaginator(terms, fetchFn)
		},
		async details(id: string): Promise<Record<string, unknown>> {
			const url = id.startsWith('http') ? id : `${BASE}/c/a/${id.trim()}/`
			return parseKompassDetails(await fetchHtml(url, fetchFn), url)
		},
	}
}

/** Default adapter using the global fetch. */
export const kompass: ScraperAdapter = createKompassAdapter()
