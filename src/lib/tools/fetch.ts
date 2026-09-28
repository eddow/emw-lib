/**
 * `fetch_webpage` — default-on lib tool. GET a URL, return title + text.
 *
 * Client-safe: network I/O goes through an injectable `FetchFn` (same
 * convention as `serps/types.ts`). Only `http(s)` URLs are fetched.
 */

import type { AgentTool } from '../alfred/tools.js'
import type { FetchFn } from '../serps/types.js'

/** Desktop UA, same as the `serps/*` adapters. */
export const FETCH_WEBPAGE_UA =
	'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'

/** Default text cap (chars). */
export const FETCH_WEBPAGE_DEFAULT_MAX_CHARS = 20_000

/** Hard ceiling, so a caller cannot ask for unbounded output. */
export const FETCH_WEBPAGE_HARD_MAX_CHARS = 100_000

export interface FetchWebpageOutput {
	url: string
	status: number
	title: string | null
	text: string
}

/** Strip scripts/styles/tags and collapse whitespace. */
export function htmlToText(html: string): { title: string | null; text: string } {
	const title = html.match(/<title[^>]*>([\s\S]{0,500})<\/title>/i)?.[1]?.trim() ?? null
	const text = html
		.replace(/<script[\s\S]*?<\/script>/gi, ' ')
		.replace(/<style[\s\S]*?<\/style>/gi, ' ')
		.replace(/<[^>]+>/g, ' ')
		.replace(/&nbsp;/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
	return { title, text }
}

/** GET `url` → `{ url, status, title, text }`. Exported for tests. */
export async function fetchWebpage(
	url: string,
	fetchFn: FetchFn = fetch,
	maxChars: number = FETCH_WEBPAGE_DEFAULT_MAX_CHARS,
	signal?: AbortSignal
): Promise<FetchWebpageOutput> {
	let parsed: URL
	try {
		parsed = new URL(url)
	} catch {
		throw new Error(`fetch_webpage: invalid url: ${url}`)
	}
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
		throw new Error(`fetch_webpage: only http(s) urls are allowed, got ${parsed.protocol}`)
	const res = await fetchFn(parsed.toString(), {
		headers: { 'user-agent': FETCH_WEBPAGE_UA },
		signal,
	})
	if (!res.ok) throw new Error(`fetch_webpage failed: ${res.status} ${res.statusText} (${url})`)
	const html = await res.text()
	const { title, text } = htmlToText(html)
	const cap = Math.min(Math.max(Math.floor(maxChars), 1), FETCH_WEBPAGE_HARD_MAX_CHARS)
	return { url: res.url || parsed.toString(), status: res.status, title, text: text.slice(0, cap) }
}

/** `AgentTool` wrapper: params `{ url, max_chars? }`. */
export function fetchWebpageTool(fetchFn: FetchFn = fetch): AgentTool {
	return {
		name: 'fetch_webpage',
		description: 'Fetch a webpage URL and return its title and text content (capped).',
		parameters: {
			type: 'object',
			properties: {
				url: { type: 'string', description: 'Absolute http(s) URL to fetch' },
				max_chars: {
					type: 'number',
					description: 'Max text chars (default 20000, hard max 100000)',
				},
			},
			required: ['url'],
		},
		execute: async (input, ctx) => {
			const { url, max_chars } = input as { url: unknown; max_chars?: unknown }
			if (typeof url !== 'string' || url.trim() === '')
				throw new Error('fetch_webpage: url must be a non-empty string')
			const max =
				typeof max_chars === 'number' && Number.isFinite(max_chars)
					? max_chars
					: FETCH_WEBPAGE_DEFAULT_MAX_CHARS
			return fetchWebpage(url, fetchFn, max, ctx.signal)
		},
	}
}
