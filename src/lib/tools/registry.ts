/**
 * Lib-tool registry — the `string[]` selector from `plans/local-tools.md`.
 *
 * Alfred gets default tools plus opt-in lib tools. The caller (e.g. `emw`'s
 * `createSession`) passes names; the registry maps each name to an
 * `AgentTool` factory. Secrets stay server-side: the host resolves keys from
 * private env and passes them via {@link LibToolDeps}.
 */

import type { AgentTool } from '../alfred/tools.js'
import type { FetchFn } from '../serps/types.js'
import { bodaccLeadsTool, bodaccParseTool } from './bodacc.js'
import { fetchWebpageTool } from './fetch.js'
import { jevDecideTool, jevMatchTool } from './jev.js'
import { serpDetailsTool, serpSearchTool } from './serps.js'
import { webSearchTool } from './websearch.js'

/** Tools Alfred gets unless the caller opts out. */
export const LIB_TOOL_DEFAULTS = ['fetch_webpage', 'web_search'] as const

/** Every tool the registry can build. */
export const LIB_TOOL_NAMES = [
	'fetch_webpage',
	'web_search',
	'jev_decide',
	'jev_match',
	'serp_search',
	'serp_details',
	'bodacc_leads',
	'bodacc_parse',
] as const

export type LibToolName = (typeof LIB_TOOL_NAMES)[number]

export interface LibToolDeps {
	/** Injectable fetch for all network tools. Defaults to global `fetch`. */
	fetchFn?: FetchFn
	/** Jev API key (OpenRouter or Typesafe). Required for `jev_*`. */
	jevApiKey?: string
	/** Jev model override (OpenRouter endpoint only). */
	jevModel?: string
	/** Jev endpoint override (e.g. the Typesafe URL). */
	jevBaseUrl?: string
	/** Brave Search API key. Unset → `web_search` uses DuckDuckGo. */
	searchApiKey?: string
}

function isLibToolName(name: string): name is LibToolName {
	return (LIB_TOOL_NAMES as readonly string[]).includes(name)
}

/** Build one lib tool by name. Throws on unknown names (fail fast). */
export function createLibTool(name: string, deps: LibToolDeps = {}): AgentTool {
	if (!isLibToolName(name)) throw new Error(`unknown lib tool: ${name}`)
	const fetchFn = deps.fetchFn ?? fetch
	switch (name) {
		case 'fetch_webpage':
			return fetchWebpageTool(fetchFn)
		case 'web_search':
			return webSearchTool({ fetchFn, apiKey: deps.searchApiKey })
		case 'jev_decide':
			return jevDecideTool({
				fetchFn,
				apiKey: deps.jevApiKey,
				model: deps.jevModel,
				baseUrl: deps.jevBaseUrl,
			})
		case 'jev_match':
			return jevMatchTool({
				fetchFn,
				apiKey: deps.jevApiKey,
				model: deps.jevModel,
				baseUrl: deps.jevBaseUrl,
			})
		case 'serp_search':
			return serpSearchTool(fetchFn)
		case 'serp_details':
			return serpDetailsTool(fetchFn)
		case 'bodacc_leads':
			return bodaccLeadsTool(fetchFn)
		case 'bodacc_parse':
			return bodaccParseTool()
	}
}

/** Build several lib tools. Duplicate names are kept (caller dedupes). */
export function resolveLibTools(names: string[], deps: LibToolDeps = {}): AgentTool[] {
	return names.map((name) => createLibTool(name, deps))
}
