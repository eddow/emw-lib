/**
 * `web_search` — default-on lib tool. Keyword web search → `ListEntry[]`.
 *
 * There is no key-free Google. When a Brave key is provided the tool uses
 * the Brave Search API; otherwise it falls back to keyless DuckDuckGo HTML
 * (`html.duckduckgo.com/html/`). Results use the shared `serps/types.ts`
 * `ListEntry` shape (`title`, `id`, `url`).
 */

import type { AgentTool } from '../alfred/tools.js'
import type { FetchFn, ListEntry } from '../serps/types.js'

const UA =
	'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'

const BRAVE_URL = 'https://api.search.brave.com/res/v1/web/search'
const DDG_URL = 'https://html.duckduckgo.com/html/'

export interface WebSearchOptions {
	fetchFn?: FetchFn
	/** Brave Search API key (`X-Subscription-Token`). Unset → DuckDuckGo fallback. */
	apiKey?: string
	/** Default result limit. */
	defaultLimit?: number
}

/** Default result limit. */
export const WEB_SEARCH_DEFAULT_LIMIT = 10

/** Hard ceiling on the result count. */
export const WEB_SEARCH_HARD_MAX_LIMIT = 20

function clampLimit(limit: unknown, dflt: number): number {
	const n = typeof limit === 'number' && Number.isFinite(limit) ? Math.floor(limit) : dflt
	return Math.min(Math.max(n, 1), WEB_SEARCH_HARD_MAX_LIMIT)
}

/** Brave API response → `ListEntry[]`. Exported for tests. */
export function parseBraveResponse(json: unknown): ListEntry[] {
	const results = (json as { web?: { results?: unknown[] } })?.web?.results
	if (!Array.isArray(results)) return []
	return results
		.filter((r) => r && typeof r === 'object')
		.map((r) => {
			const item = r as Record<string, unknown>
			const url = typeof item.url === 'string' ? item.url : ''
			const title = typeof item.title === 'string' ? item.title : url
			return { title, id: url, url, description: item.description ?? null }
		})
		.filter((e) => e.url !== '')
}

/** Decode a small subset of HTML entities (DDG titles/snippets). */
function decodeEntities(s: string): string {
	return s
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#x27;|&#39;/g, "'")
		.replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)))
}

/** DuckDuckGo HTML page → `ListEntry[]`. Exported for tests. */
export function parseDuckDuckGoResponse(html: string): ListEntry[] {
	const entries: ListEntry[] = []
	const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
	let m: RegExpExecArray | null
	while ((m = re.exec(html)) !== null) {
		const url = m[1].trim()
		const title = decodeEntities(
			m[2]
				.replace(/<[^>]+>/g, ' ')
				.replace(/\s+/g, ' ')
				.trim()
		)
		if (url) entries.push({ title: title || url, id: url, url })
	}
	return entries
}

/** Run one web search. Exported for tests. */
export async function webSearch(
	query: string,
	opts: WebSearchOptions = {},
	limit: number = WEB_SEARCH_DEFAULT_LIMIT,
	signal?: AbortSignal
): Promise<ListEntry[]> {
	if (!query.trim()) throw new Error('web_search: q must not be empty')
	const fetchFn = opts.fetchFn ?? fetch
	const n = clampLimit(limit, opts.defaultLimit ?? WEB_SEARCH_DEFAULT_LIMIT)
	if (opts.apiKey) {
		const url = `${BRAVE_URL}?q=${encodeURIComponent(query.trim())}&count=${n}`
		const res = await fetchFn(url, {
			headers: { accept: 'application/json', 'X-Subscription-Token': opts.apiKey },
			signal,
		})
		if (!res.ok) throw new Error(`web_search (brave) failed: ${res.status} ${res.statusText}`)
		return parseBraveResponse(await res.json()).slice(0, n)
	}
	const res = await fetchFn(`${DDG_URL}?q=${encodeURIComponent(query.trim())}`, {
		headers: { 'user-agent': UA },
		signal,
	})
	if (!res.ok) throw new Error(`web_search (duckduckgo) failed: ${res.status} ${res.statusText}`)
	return parseDuckDuckGoResponse(await res.text()).slice(0, n)
}

/** `AgentTool` wrapper: params `{ q, limit? }`. */
export function webSearchTool(opts: WebSearchOptions = {}): AgentTool {
	return {
		name: 'web_search',
		description:
			'Keyword web search returning title/url entries (Brave API when configured, else DuckDuckGo).',
		parameters: {
			type: 'object',
			properties: {
				q: { type: 'string', description: 'Search query' },
				limit: { type: 'number', description: 'Max results (default 10, hard max 20)' },
			},
			required: ['q'],
		},
		execute: async (input, ctx) => {
			const { q, limit } = input as { q: unknown; limit?: unknown }
			if (typeof q !== 'string' || q.trim() === '')
				throw new Error('web_search: q must be a non-empty string')
			return webSearch(
				q,
				opts,
				clampLimit(limit, opts.defaultLimit ?? WEB_SEARCH_DEFAULT_LIMIT),
				ctx.signal
			)
		},
	}
}
