import type { FetchFn, ListEntry, Paginator, ScraperAdapter } from '../types.js'
import { parseSuprevaResponse, suprevaMaxPages, toListEntry } from './parse.js'

const BASE = 'https://supreva.com'
const UA =
	'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'

/**
 * Build the Supreva keyword-search URL for `terms` and 1-based `page`.
 * Page 1 is `/en/search/<terms>/`; later pages use the `pg-N` segment.
 * The `?init_page=1` query asks the backend for the JSON (react) payload.
 */
export function suprevaSearchUrl(terms: string, page = 1): string {
	const q = encodeURIComponent(terms.trim().toLowerCase()).replace(/%20/g, '+')
	const base = page > 1 ? `${BASE}/en/search/${q}/pg-${page}/` : `${BASE}/en/search/${q}/`
	return `${base}?init_page=1`
}

async function fetchPageJson(url: string, fetchFn: FetchFn): Promise<unknown> {
	const res = await fetchFn(url, {
		headers: { 'user-agent': UA, accept: 'application/json', 'content-type': 'application/json' },
	})
	if (!res.ok) throw new Error(`supreva search failed: ${res.status} ${res.statusText} (${url})`)
	return await res.json()
}

class SuprevaPaginator implements Paginator {
	maxPages: number = NaN
	private maxPagesResolved = false

	constructor(
		private terms: string,
		private fetchFn: FetchFn
	) {}

	async page(n: number): Promise<ListEntry[]> {
		if (!Number.isInteger(n) || n < 1) throw new RangeError(`supreva: page must be >= 1, got ${n}`)
		if (!Number.isNaN(this.maxPages) && n > this.maxPages)
			throw new RangeError(`supreva: page ${n} exceeds maxPages ${this.maxPages}`)
		const json = await fetchPageJson(suprevaSearchUrl(this.terms, n), this.fetchFn)
		const parsed = parseSuprevaResponse(json)
		if (!parsed)
			throw new Error(`supreva: unexpected response shape (${suprevaSearchUrl(this.terms, n)})`)
		if (!this.maxPagesResolved) {
			this.maxPages = suprevaMaxPages(parsed.total, parsed.limit)
			this.maxPagesResolved = true
		}
		return parsed.items.map((item) => toListEntry(item, BASE))
	}
}

export function createSuprevaAdapter(fetchFn: FetchFn = fetch): ScraperAdapter {
	return {
		name: 'supreva',
		async search(terms: string): Promise<Paginator> {
			if (!terms.trim()) throw new Error('supreva: search terms must not be empty')
			return new SuprevaPaginator(terms, fetchFn)
		},
	}
}

/** Default adapter using the global fetch. */
export const supreva: ScraperAdapter = createSuprevaAdapter()
