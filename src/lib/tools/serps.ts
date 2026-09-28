/**
 * `serp_search` + `serp_details` — opt-in lib tools dispatching to the
 * existing `serps/*` adapters by `source` name.
 *
 * `serp_search` returns `{ entries, maxPages }` from the first page;
 * `serp_details` returns the adapter's `details()` record. Only
 * `annuaire-entreprises`, `europages`, `kompass` and `pagesjaunes` support
 * details — the others throw a tool error.
 */

import type { AgentTool } from '../alfred/tools.js'
import { createAnnuaireAdapter } from '../serps/annuaire-entreprises/index.js'
import { createAosomAdapter } from '../serps/aosom/index.js'
import { createEmagAdapter, type EmagLocale } from '../serps/emag/index.js'
import { createEuropagesAdapter } from '../serps/europages/index.js'
import { createKompassAdapter } from '../serps/kompass/index.js'
import { createPagesjaunesAdapter } from '../serps/pagesjaunes/index.js'
import { createSuprevaAdapter } from '../serps/supreva/index.js'
import type { FetchFn, ListEntry, ScraperAdapter } from '../serps/types.js'

/** Sources addressable via the `source` param. */
export const SERP_SOURCES = [
	'annuaire-entreprises',
	'aosom',
	'emag.ro',
	'emag.bg',
	'emag.hu',
	'europages',
	'kompass',
	'pagesjaunes',
	'supreva',
] as const

export type SerpSource = (typeof SERP_SOURCES)[number]

/** Sources with a useful `details()` page. */
const DETAIL_SOURCES: ReadonlySet<SerpSource> = new Set([
	'annuaire-entreprises',
	'europages',
	'kompass',
	'pagesjaunes',
])

/** Max entries returned per search call. */
export const SERP_SEARCH_LIMIT = 20

function isSerpSource(value: unknown): value is SerpSource {
	return typeof value === 'string' && (SERP_SOURCES as readonly string[]).includes(value)
}

/** Instantiate the adapter for `source`. Exported for tests. */
export function adapterFor(source: SerpSource, fetchFn: FetchFn = fetch): ScraperAdapter {
	switch (source) {
		case 'annuaire-entreprises':
			return createAnnuaireAdapter(fetchFn)
		case 'aosom':
			return createAosomAdapter(fetchFn)
		case 'emag.ro':
		case 'emag.bg':
		case 'emag.hu': {
			const locale = source.split('.')[1] as EmagLocale
			return createEmagAdapter(fetchFn, locale)
		}
		case 'europages':
			return createEuropagesAdapter(fetchFn)
		case 'kompass':
			return createKompassAdapter(fetchFn)
		case 'pagesjaunes':
			return createPagesjaunesAdapter(fetchFn)
		case 'supreva':
			return createSuprevaAdapter(fetchFn)
	}
}

/** Run one search, first page only. Exported for tests. */
export async function serpSearch(
	source: SerpSource,
	terms: string,
	fetchFn: FetchFn = fetch,
	signal?: AbortSignal
): Promise<{ entries: ListEntry[]; maxPages: number }> {
	if (!terms.trim()) throw new Error('serp_search: terms must not be empty')
	if (signal?.aborted) throw new Error('serp_search: aborted')
	const paginator = await adapterFor(source, fetchFn).search(terms)
	const entries = (await paginator.page(1)).slice(0, SERP_SEARCH_LIMIT)
	return { entries, maxPages: paginator.maxPages }
}

/** `AgentTool` wrapper: params `{ source, terms }` (pagesjaunes: `"<what> <where>"`). */
export function serpSearchTool(fetchFn: FetchFn = fetch): AgentTool {
	return {
		name: 'serp_search',
		description: `Search a directory/marketplace (${SERP_SOURCES.join(', ')}) — first page of entries.`,
		parameters: {
			type: 'object',
			properties: {
				source: { type: 'string', description: `One of: ${SERP_SOURCES.join(', ')}` },
				terms: {
					type: 'string',
					description:
						'Search terms (pagesjaunes: "<activity> <locality>", e.g. "boulangerie Paris")',
				},
			},
			required: ['source', 'terms'],
		},
		execute: async (input, ctx) => {
			const { source, terms } = input as { source: unknown; terms: unknown }
			if (!isSerpSource(source)) throw new Error(`serp_search: unknown source: ${String(source)}`)
			if (typeof terms !== 'string' || terms.trim() === '')
				throw new Error('serp_search: terms must be a non-empty string')
			return serpSearch(source, terms, fetchFn, ctx.signal)
		},
	}
}

/** `AgentTool` wrapper: params `{ source, id }`. */
export function serpDetailsTool(fetchFn: FetchFn = fetch): AgentTool {
	return {
		name: 'serp_details',
		description:
			'Fetch a company/item detail record (annuaire-entreprises: 9-digit SIREN; others: id or URL).',
		parameters: {
			type: 'object',
			properties: {
				source: { type: 'string', description: `One of: ${[...DETAIL_SOURCES].join(', ')}` },
				id: { type: 'string', description: 'SIREN, numeric id, or full company URL' },
			},
			required: ['source', 'id'],
		},
		execute: async (input) => {
			const { source, id } = input as { source: unknown; id: unknown }
			if (!isSerpSource(source) || !DETAIL_SOURCES.has(source))
				throw new Error(`serp_details: unsupported source: ${String(source)}`)
			if (typeof id !== 'string' || id.trim() === '')
				throw new Error('serp_details: id must be a non-empty string')
			const adapter = adapterFor(source, fetchFn)
			if (!adapter.details) throw new Error(`serp_details: ${source} has no details()`)
			return adapter.details(id)
		},
	}
}
