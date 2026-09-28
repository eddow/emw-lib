/**
 * `bodacc_leads` + `bodacc_parse` — opt-in lib tools over the BODACC scraper
 * (`src/lib/scrappers/bodacc/client.ts`, keyless OpenDataSoft API).
 *
 * `bodacc_leads` runs `fetchBodaccLeads()` with `BodaccQueryOptions`;
 * `bodacc_parse` decodes one raw `BodaccRecord` into `{ siren, name,
 * persons, establishments, judgment, act, deposit }`.
 */

import type { AgentTool } from '../alfred/tools.js'
import {
	fetchBodaccLeads,
	getActe,
	getCompanyName,
	getDepot,
	getEtablissements,
	getJugement,
	getPersonnes,
	getSiren,
} from '../scrappers/bodacc/client.js'
import type { BodaccQueryOptions, BodaccRecord } from '../scrappers/bodacc/types.js'
import type { FetchFn } from '../serps/types.js'

const CATEGORIES = [
	'creation',
	'immatriculation',
	'modification',
	'vente',
	'collective',
	'conciliation',
	'retablissement_professionnel',
	'radiation',
	'dpc',
	'divers',
	'inconnue',
] as const

function clampLimit(limit: unknown): number {
	const n = typeof limit === 'number' && Number.isFinite(limit) ? Math.floor(limit) : 20
	return Math.min(Math.max(n, 1), 100)
}

/** `AgentTool` wrapper: params `BodaccQueryOptions` → `BodaccRecord[]`. */
export function bodaccLeadsTool(fetchFn: FetchFn = fetch): AgentTool {
	return {
		name: 'bodacc_leads',
		description:
			'Search BODACC company notices (creations, modifications, sales, ...) by category/department/date.',
		parameters: {
			type: 'object',
			properties: {
				category: {
					type: 'string',
					description: `One of: ${CATEGORIES.join(', ')} (default creation)`,
				},
				department: { type: 'string', description: 'Department number, e.g. "69", "2A"' },
				dateFrom: {
					type: 'string',
					description: 'Inclusive lower bound on dateparution (YYYY-MM-DD)',
				},
				limit: { type: 'number', description: 'Max records (default 20, hard max 100)' },
				offset: { type: 'number', description: 'Pagination offset (default 0)' },
			},
			required: [],
		},
		execute: async (input) => {
			const { category, department, dateFrom, limit, offset } = input as {
				category?: unknown
				department?: unknown
				dateFrom?: unknown
				limit?: unknown
				offset?: unknown
			}
			const opts: BodaccQueryOptions = {}
			if (category !== undefined) {
				if (typeof category !== 'string' || !(CATEGORIES as readonly string[]).includes(category))
					throw new Error(`bodacc_leads: unknown category: ${String(category)}`)
				opts.category = category as BodaccQueryOptions['category']
			}
			if (department !== undefined) {
				if (typeof department !== 'string' || department.trim() === '')
					throw new Error('bodacc_leads: department must be a non-empty string')
				opts.department = department
			}
			if (dateFrom !== undefined) {
				if (typeof dateFrom !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateFrom))
					throw new Error('bodacc_leads: dateFrom must be YYYY-MM-DD')
				opts.dateFrom = dateFrom
			}
			opts.limit = clampLimit(limit)
			if (offset !== undefined) {
				const n = typeof offset === 'number' && Number.isFinite(offset) ? Math.floor(offset) : NaN
				if (!Number.isInteger(n) || n < 0) throw new Error('bodacc_leads: offset must be >= 0')
				opts.offset = n
			}
			return fetchBodaccLeads(opts, fetchFn)
		},
	}
}

/** Decode one raw record. Exported for tests. */
export function parseBodaccRecord(record: BodaccRecord): Record<string, unknown> {
	return {
		siren: getSiren(record),
		name: getCompanyName(record),
		persons: getPersonnes(record),
		establishments: getEtablissements(record),
		judgment: getJugement(record),
		act: getActe(record),
		deposit: getDepot(record),
	}
}

/** `AgentTool` wrapper: params `{ record }` → decoded company summary. */
export function bodaccParseTool(): AgentTool {
	return {
		name: 'bodacc_parse',
		description:
			'Decode a raw BODACC record into siren/name/persons/establishments/judgment/act/deposit.',
		parameters: {
			type: 'object',
			properties: {
				record: { type: 'object', description: 'Raw BODACC record (one item of bodacc_leads)' },
			},
			required: ['record'],
		},
		execute: async (input) => {
			const { record } = input as { record: unknown }
			if (!record || typeof record !== 'object' || Array.isArray(record))
				throw new Error('bodacc_parse: record must be an object')
			return parseBodaccRecord(record as BodaccRecord)
		},
	}
}
