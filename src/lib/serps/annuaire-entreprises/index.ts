import type { FetchFn, ListEntry, Paginator, ScraperAdapter } from '../types.js'
import {
	type AnnuaireRawCompany,
	annuaireMaxPages,
	parseAnnuaireResponse,
	toDetails,
	toListEntry,
} from './parse.js'

const BASE = 'https://recherche-entreprises.api.gouv.fr'
const UA =
	'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'

/** Results per page requested from the API (max 100). */
const PER_PAGE = 20

/**
 * Build the API Recherche d'Entreprises search URL for `terms` and 1-based `page`.
 * Open API, no key. Docs: https://recherche-entreprises.api.gouv.fr/docs/
 */
export function annuaireSearchUrl(terms: string, page = 1): string {
	const q = encodeURIComponent(terms.trim()).replace(/%20/g, '+')
	return `${BASE}/search?q=${q}&page=${page}&per_page=${PER_PAGE}`
}

/** Fetch one company by SIREN (used by `details()`). */
export function annuaireCompanyUrl(siren: string): string {
	return `${BASE}/search?q=${encodeURIComponent(siren)}&page=1&per_page=1`
}

async function fetchJson(url: string, fetchFn: FetchFn): Promise<unknown> {
	const res = await fetchFn(url, {
		headers: { 'user-agent': UA, accept: 'application/json' },
	})
	if (!res.ok)
		throw new Error(`annuaire-entreprises search failed: ${res.status} ${res.statusText} (${url})`)
	return await res.json()
}

class AnnuairePaginator implements Paginator {
	maxPages: number = NaN
	private maxPagesResolved = false

	constructor(
		private terms: string,
		private fetchFn: FetchFn
	) {}

	async page(n: number): Promise<ListEntry[]> {
		if (!Number.isInteger(n) || n < 1)
			throw new RangeError(`annuaire-entreprises: page must be >= 1, got ${n}`)
		if (!Number.isNaN(this.maxPages) && n > this.maxPages)
			throw new RangeError(`annuaire-entreprises: page ${n} exceeds maxPages ${this.maxPages}`)
		const json = await fetchJson(annuaireSearchUrl(this.terms, n), this.fetchFn)
		const parsed = parseAnnuaireResponse(json)
		if (!parsed)
			throw new Error(
				`annuaire-entreprises: unexpected response shape (${annuaireSearchUrl(this.terms, n)})`
			)
		if (!this.maxPagesResolved) {
			this.maxPages = annuaireMaxPages(parsed.total, parsed.limit)
			this.maxPagesResolved = true
		}
		return parsed.items.map(toListEntry)
	}
}

async function fetchCompany(siren: string, fetchFn: FetchFn): Promise<AnnuaireRawCompany> {
	const json = await fetchJson(annuaireCompanyUrl(siren), fetchFn)
	const parsed = parseAnnuaireResponse(json)
	const item = parsed?.items.find((c) => c.siren === siren) ?? parsed?.items[0]
	if (!item) throw new Error(`annuaire-entreprises: no company found for SIREN ${siren}`)
	return item
}

export function createAnnuaireAdapter(fetchFn: FetchFn = fetch): ScraperAdapter {
	return {
		name: 'annuaire-entreprises',
		async search(terms: string): Promise<Paginator> {
			if (!terms.trim()) throw new Error('annuaire-entreprises: search terms must not be empty')
			return new AnnuairePaginator(terms, fetchFn)
		},
		async details(id: string): Promise<Record<string, unknown>> {
			if (!/^\d{9}$/.test(id.trim()))
				throw new Error(`annuaire-entreprises: details() expects a 9-digit SIREN, got ${id}`)
			return toDetails(await fetchCompany(id.trim(), fetchFn))
		},
	}
}

/** Default adapter using the global fetch. */
export const annuaireEntreprises: ScraperAdapter = createAnnuaireAdapter()
