import type { FetchFn, ListEntry, Paginator, ScraperAdapter } from '../types.js'
import {
	parsePagesjaunesDetails,
	parsePagesjaunesMaxPages,
	parsePagesjaunesSearchPage,
} from './parse.js'

const BASE = 'https://www.pagesjaunes.fr'
const UA =
	'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'

/**
 * Build the PagesJaunes professional-search URL.
 * `what` is the activity (`boulangerie`), `where` the locality (`Paris-75`).
 * Page 1 is the bare URL; later pages append `&page=N` (verified live:
 * `&page=2` returns `Page 2 / 59` with 20 cards).
 */
export function pagesjaunesSearchUrl(what: string, where: string, page = 1): string {
	const q = encodeURIComponent(what.trim()).replace(/%20/g, '+')
	const o = encodeURIComponent(where.trim()).replace(/%20/g, '+')
	const base = `${BASE}/annuaire/chercherlespros?quoiqui=${q}&ou=${o}`
	return page > 1 ? `${base}&page=${page}` : base
}

async function fetchHtml(url: string, fetchFn: FetchFn): Promise<string> {
	const res = await fetchFn(url, { headers: { 'user-agent': UA } })
	if (!res.ok)
		throw new Error(`pagesjaunes search failed: ${res.status} ${res.statusText} (${url})`)
	return await res.text()
}

class PagesjaunesPaginator implements Paginator {
	maxPages: number = NaN
	private maxPagesResolved = false

	constructor(
		private what: string,
		private where: string,
		private fetchFn: FetchFn
	) {}

	async page(n: number): Promise<ListEntry[]> {
		if (!Number.isInteger(n) || n < 1)
			throw new RangeError(`pagesjaunes: page must be >= 1, got ${n}`)
		if (!Number.isNaN(this.maxPages) && n > this.maxPages)
			throw new RangeError(`pagesjaunes: page ${n} exceeds maxPages ${this.maxPages}`)
		const html = await fetchHtml(pagesjaunesSearchUrl(this.what, this.where, n), this.fetchFn)
		if (!this.maxPagesResolved) {
			this.maxPages = parsePagesjaunesMaxPages(html)
			this.maxPagesResolved = true
		}
		return parsePagesjaunesSearchPage(html)
	}
}

export interface PagesjaunesQuery {
	what: string
	where: string
}

export function createPagesjaunesAdapter(fetchFn: FetchFn = fetch): ScraperAdapter {
	return {
		name: 'pagesjaunes',
		async search(terms: string): Promise<Paginator> {
			const query = parseTerms(terms)
			return new PagesjaunesPaginator(query.what, query.where, fetchFn)
		},
		async details(id: string): Promise<Record<string, unknown>> {
			const url = id.startsWith('http') ? id : `${BASE}/pros/${id.trim()}`
			return parsePagesjaunesDetails(await fetchHtml(url, fetchFn), url)
		},
	}
}

/**
 * Split free-text `terms` into activity + locality.
 * Accepts `boulangerie Paris-75`, `boulangerie à Paris`, or `boulangerie, Paris`.
 * Without a locality separator the whole terms are the activity and `where`
 * defaults to `France`.
 */
export function parseTerms(terms: string): PagesjaunesQuery {
	const t = terms.trim()
	if (!t) throw new Error('pagesjaunes: search terms must not be empty')
	const m = t.match(/^(.*?)(?:\s+à\s+|\s*,\s*|\s+(?=[A-ZÀ-Þ\d][\w\-']*(?:\s|$)))(.+)$/)
	if (m && m[1].trim() && m[2].trim()) return { what: m[1].trim(), where: m[2].trim() }
	return { what: t, where: 'France' }
}

/** Default adapter using the global fetch. */
export const pagesjaunes: ScraperAdapter = createPagesjaunesAdapter()
