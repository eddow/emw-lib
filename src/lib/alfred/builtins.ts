/**
 * Builtin tool catalogue — descriptors for Alfred's in-process tools
 * (butler `docs/tools.md` §§3–4, executed as `execution.type: 'builtin'`).
 *
 * Descriptors only: no `execute`, no fetch, no secrets. The model-facing
 * `description` + JSON Schema `parameters` live here so `emw` can advertise
 * builtins in the session toolset without re-implementing them — Alfred owns
 * the implementation (`butler/src/alfred/builtins/`).
 */

import { type BuiltinToolDef, toBuiltinToolset } from './tools.js'

/** Generic primitives (docs/tools.md §3). */
export const BUILTIN_GENERIC: BuiltinToolDef[] = [
	{
		name: 'time',
		description:
			'Deterministic clock: now/parse/convert/duration/business_days (ISO-8601, IANA tz).',
		parameters: {
			type: 'object',
			properties: {
				op: { type: 'string', description: 'now|parse|convert|duration|business_days' },
				args: { type: 'object', description: 'op args (tz, value, from/to, country)' },
			},
			required: ['op'],
		},
	},
	{
		name: 'calc',
		description: 'Safe arithmetic: + - * / % ** () and whitelisted math.* (no code exec).',
		parameters: {
			type: 'object',
			properties: { expr: { type: 'string' } },
			required: ['expr'],
		},
	},
	{
		name: 'units',
		description:
			'Deterministic unit conversion (length, mass, volume, …). Currency excluded — see fx.',
		parameters: {
			type: 'object',
			properties: {
				value: { type: 'number' },
				from: { type: 'string' },
				to: { type: 'string' },
			},
			required: ['value', 'from', 'to'],
		},
	},
	{
		name: 'validate',
		description: 'JSON-Schema check (+ url/email/date/currency shortcuts). Pairs with extract.',
		parameters: {
			type: 'object',
			properties: {
				value: {},
				schema: { type: 'object' },
			},
			required: ['value', 'schema'],
		},
	},
	{
		name: 'compare',
		description: 'Structural diff of two objects (added/removed/changed, numeric delta).',
		parameters: {
			type: 'object',
			properties: {
				left: { type: 'object' },
				right: { type: 'object' },
				fields: { type: 'array', items: { type: 'string' } },
			},
			required: ['left', 'right'],
		},
	},
	{
		name: 'transform',
		description:
			'Declarative ops over arrays: map|filter|group|sort|dedupe|flatten|join|pivot|aggregate.',
		parameters: {
			type: 'object',
			properties: {
				input: { type: 'array' },
				op: { type: 'string' },
				spec: { type: 'object' },
			},
			required: ['input', 'op'],
		},
	},
	{
		name: 'fetch_webpage',
		description: 'Fetch a webpage URL and return its title and text content (capped).',
		parameters: {
			type: 'object',
			properties: {
				url: { type: 'string' },
				max_chars: { type: 'number' },
			},
			required: ['url'],
		},
	},
	{
		name: 'http',
		description: 'Raw API/RSS/JSON endpoint access (status + truncated body + content-type).',
		parameters: {
			type: 'object',
			properties: {
				method: { type: 'string' },
				url: { type: 'string' },
				headers: { type: 'object' },
				query: { type: 'object' },
				body: {},
			},
			required: ['method', 'url'],
		},
	},
	{
		name: 'web_search',
		description:
			'Keyword web search returning title/url entries (Serper API when configured, else DuckDuckGo).',
		parameters: {
			type: 'object',
			properties: {
				q: { type: 'string' },
				country: { type: 'string', description: '2-letters Country code' },
				language: { type: 'string', description: '2-letters Language code' },
				// TODO: "tbs": "qdr:#" h-d-w-m-y: last hour-day-...-year
				limit: { type: 'number' },
				rerank: { type: 'boolean' },
			},
			required: ['q'],
		},
	},
	{
		name: 'extract',
		description: 'Typed extraction: url|html|pdf|image source + JSON schema → validated object.',
		parameters: {
			type: 'object',
			properties: {
				source: { type: 'string' },
				schema: { type: 'object' },
			},
			required: ['source', 'schema'],
		},
	},
	{
		name: 'inspect',
		description:
			'Detect type → OCR/vision/document-parser → extract → validate. Facade over document/image/extract.',
		parameters: {
			type: 'object',
			properties: {
				input: { type: 'string' },
				schema: { type: 'object' },
			},
			required: ['input'],
		},
	},
	{
		name: 'recall',
		description: 'Semantic search over session artifact/document collections.',
		parameters: {
			type: 'object',
			properties: {
				query: { type: 'string' },
				collection: { type: 'string' },
				top_n: { type: 'number' },
			},
			required: ['query', 'collection'],
		},
	},
	{
		name: 'resolve',
		description:
			'Generic entity resolution over candidates (embed pre-filter → rerank → LLM resolve).',
		parameters: {
			type: 'object',
			properties: {
				candidates: { type: 'array' },
				keys: { type: 'array', items: { type: 'string' } },
			},
			required: ['candidates', 'keys'],
		},
	},
	{
		name: 'jev_decide',
		description:
			'Typed decision (noul P(true) / choice pick / score level) via the decide backend — OpenRouter Decisions API by default, self-hosted Laya when ALFRED_DECIDE_URL is set. Returns the raw answers map.',
		parameters: {
			type: 'object',
			properties: {
				state: { type: 'object' },
				questions: { type: 'object' },
				model: {
					type: 'string',
					description:
						'Checkpoint pin (Laya: english|multilingual|typed-decisions) or Jev slug. Empty = auto-select.',
				},
			},
			required: ['state', 'questions'],
		},
	},
	{
		name: 'artifact',
		description:
			'Session-scoped blobs (create|read|list) so large intermediates leave the context.',
		parameters: {
			type: 'object',
			properties: {
				op: { type: 'string' },
				type: { type: 'string' },
				name: { type: 'string' },
				content: {},
			},
			required: ['op'],
		},
	},
	{
		name: 'document',
		description: 'Raw parser primitive (read|extract|search) behind inspect/extract.',
		parameters: {
			type: 'object',
			properties: {
				op: { type: 'string' },
				file: { type: 'string' },
				schema: { type: 'object' },
				query: { type: 'string' },
			},
			required: ['op'],
		},
	},
	{
		name: 'geo',
		description: 'Geocode|reverse|distance via keyless Photon/Nominatim.',
		parameters: {
			type: 'object',
			properties: {
				op: { type: 'string' },
				args: { type: 'object' },
			},
			required: ['op'],
		},
	},
	{
		name: 'phone',
		description: 'Parse/format/validate phone numbers (E.164, national/international).',
		parameters: {
			type: 'object',
			properties: {
				op: { type: 'string' },
				number: { type: 'string' },
				region: { type: 'string' },
			},
			required: ['op', 'number'],
		},
	},
	{
		name: 'feed',
		description: 'RSS/Atom URL → entries (title, link, published, summary).',
		parameters: {
			type: 'object',
			properties: {
				url: { type: 'string' },
				max_items: { type: 'number' },
				since: { type: 'string' },
			},
			required: ['url'],
		},
	},
	{
		name: 'net',
		description:
			'Domain intel: dns|redirects|ssl|headers (records, cert, redirect chain; whois is a legacy alias of redirects).',
		parameters: {
			type: 'object',
			properties: {
				op: { type: 'string' },
				host: { type: 'string' },
			},
			required: ['op', 'host'],
		},
	},
	{
		name: 'sitemap',
		description: 'URL → page list via sitemap.xml (incl. index recursion + robots.txt fallback).',
		parameters: {
			type: 'object',
			properties: {
				url: { type: 'string' },
				max_urls: { type: 'number' },
			},
			required: ['url'],
		},
	},
	{
		name: 'scrape',
		description:
			'Spec-driven page read: url (+ optional spec name) → validated data. Specs: annuaire.companies, annuaire.company, aosom.products, bodacc.record, bodacc.records, emag.products, europages.companies, europages.company, kompass.companies, kompass.company, pagesjaunes.pro, pagesjaunes.pros, supreva.products. Omitted spec = auto-match by URL.',
		parameters: {
			type: 'object',
			properties: {
				url: { type: 'string', description: 'Page URL to read.' },
				spec: {
					type: 'string',
					description: 'Spec name (filename stem); omitted = auto-match by url_patterns.',
				},
				max_chars: {
					type: 'number',
					description:
						'LLM-fallback input cap (deterministic rules: always run on the full document).',
				},
			},
			required: ['url'],
		},
	},
	{
		name: 'image',
		description: 'Raw vision read (describe|ocr|extract_table) behind inspect/extract.',
		parameters: {
			type: 'object',
			properties: {
				op: { type: 'string' },
				image: { type: 'string' },
				lang: { type: 'string' },
			},
			required: ['op', 'image'],
		},
	},
]

/** Specialised domain accelerators (docs/tools.md §4). */
/** Standard serp-search item: every `serp_search` list entry carries at least these. */
export type SerpItem = {
	title: string
	url: string
	id: string
	[key: string]: unknown
}
export const BUILTIN_SPECIALISED: BuiltinToolDef[] = [
	{
		name: 'jev_match',
		description:
			'P(both titles are the exact same physical product) via noul (0..1, match ≥ 0.8). Optional model pins the Laya checkpoint.',
		parameters: {
			type: 'object',
			properties: {
				a_title: { type: 'string' },
				b_title: { type: 'string' },
				model: { type: 'string' },
			},
			required: ['a_title', 'b_title'],
		},
	},
	{
		name: 'serp_search',
		description:
			'Spec-driven directory/marketplace search (serps: annuaire-entreprises, aosom, bodacc, emag, europages, kompass, pagesjaunes, supreva — emag.ro/bg/hu are a lang shim for emag). Args per serp: terms?/lang?/page?/where?/category?/department?/dateFrom?/limit?/offset? + rerank?. Returns {items: SerpItem[] (title, url, id), maxPages: null when unknown}.',
		parameters: {
			type: 'object',
			properties: {
				source: { type: 'string', description: 'Serp name (serps/*.yaml stem).' },
				terms: {
					type: 'string',
					description: 'Raw query text (omitted for filter-only searches like bodacc).',
				},
				lang: {
					type: 'string',
					description: 'Search language / site locale (e.g. emag ro|bg|hu).',
				},
				where: { type: 'string', description: 'Location filter (pagesjaunes).' },
				page: { type: 'number', description: 'Result page (1-based).' },
				category: { type: 'string', description: 'BODACC notice family (bodacc).' },
				department: { type: 'string', description: 'French department number (bodacc).' },
				dateFrom: { type: 'string', description: 'BODACC earliest date, YYYY-MM-DD (bodacc).' },
				limit: { type: 'number', description: 'Max items (bodacc up to 100).' },
				offset: { type: 'number', description: 'BODACC result offset.' },
				rerank: { type: 'boolean' },
			},
			required: ['source'],
		},
	},
	{
		name: 'serp_details',
		description:
			"Fetch a company/item detail record via the serp's details scraper (annuaire-entreprises, bodacc, europages, kompass, pagesjaunes; aosom/emag/supreva are search-only → use scrape). id = record key or URL.",
		parameters: {
			type: 'object',
			properties: {
				source: { type: 'string' },
				id: { type: 'string' },
			},
			required: ['source', 'id'],
		},
	},
	{
		name: 'bodacc_parse',
		description:
			'Decode a raw BODACC record into siren/name/persons/establishments/judgment/act/deposit.',
		parameters: {
			type: 'object',
			properties: {
				record: { type: 'object' },
			},
			required: ['record'],
		},
	},
	{
		name: 'fx',
		description: 'Live currency conversion (ECB daily rates via frankfurter).',
		parameters: {
			type: 'object',
			properties: {
				amount: { type: 'number' },
				from: { type: 'string' },
				to: { type: 'string' },
				date: { type: 'string' },
			},
			required: ['amount', 'from', 'to'],
		},
	},
	{
		name: 'company_id',
		description: 'SIREN/SIRET Luhn validation + EU VAT check via VIES.',
		parameters: {
			type: 'object',
			properties: {
				op: { type: 'string' },
				value: { type: 'string' },
				country: { type: 'string' },
			},
			required: ['op', 'value'],
		},
	},
]

/** Every builtin Alfred executes in-process. */
export const BUILTIN_TOOL_NAMES = [
	...BUILTIN_GENERIC.map((t) => t.name),
	...BUILTIN_SPECIALISED.map((t) => t.name),
] as const

/** `ToolDef[]` with `execution.type: 'builtin'` for the named builtins. */
export function builtinToolset(names: string[]) {
	const byName = new Map<string, BuiltinToolDef>(
		[...BUILTIN_GENERIC, ...BUILTIN_SPECIALISED].map((t) => [t.name, t])
	)
	const defs = names.map((name) => {
		const def = byName.get(name)
		if (!def) throw new Error(`unknown builtin tool: ${name}`)
		return def
	})
	return toBuiltinToolset(defs)
}
