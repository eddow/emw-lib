import type {
	BodaccActe,
	BodaccApiResponse,
	BodaccDepot,
	BodaccEtablissement,
	BodaccJugement,
	BodaccPersonne,
	BodaccQueryOptions,
	BodaccRecord,
} from './types.js'

export const BODACC_API_URL =
	'https://bodacc-datadila.opendatasoft.com/api/explore/v2.1/catalog/datasets/annonces-commerciales/records'

export type FetchFn = typeof fetch

/** Build the request URL without sending it (exported for tests). */
export function buildBodaccUrl(options: BodaccQueryOptions = {}): string {
	const { category = 'creation', department, dateFrom, limit = 20, offset = 0 } = options

	// NOTE: `familleavis` stores a CODE (creation, modification, ...), not the
	// French label. The department field is `numerodepartement`, not `departement`.
	const conditions: string[] = []
	if (category) conditions.push(`familleavis = "${category}"`)
	if (department) conditions.push(`numerodepartement = "${department}"`)
	if (dateFrom) conditions.push(`dateparution >= "${dateFrom}"`)

	const params = new URLSearchParams({
		limit: limit.toString(),
		offset: offset.toString(),
		order_by: 'dateparution DESC',
	})
	const whereClause = conditions.join(' AND ')
	if (whereClause) params.append('where', whereClause)

	return `${BODACC_API_URL}?${params.toString()}`
}

export async function fetchBodaccLeads(
	options: BodaccQueryOptions = {},
	fetchFn: FetchFn = fetch
): Promise<BodaccRecord[]> {
	const targetUrl = buildBodaccUrl(options)
	const response = await fetchFn(targetUrl)
	if (!response.ok) {
		throw new Error(`BODACC API error: ${response.status} ${response.statusText}`)
	}
	const data = (await response.json()) as BodaccApiResponse
	return data.results
}

/** Parse a JSON-encoded sub-field (`listepersonnes`, `acte`, ...). Returns null on missing/invalid. */
export function parseJsonField<T>(raw: string | null | undefined): T | null {
	if (!raw) return null
	try {
		return JSON.parse(raw) as T
	} catch {
		return null
	}
}

function asArray<T>(value: T | T[] | null | undefined): T[] {
	if (value == null) return []
	return Array.isArray(value) ? value : [value]
}

/** Persons from `listepersonnes` (`{"personne": {...} | [...]}`). */
export function getPersonnes(record: BodaccRecord): BodaccPersonne[] {
	const parsed = parseJsonField<{ personne?: BodaccPersonne | BodaccPersonne[] }>(
		record.listepersonnes
	)
	return asArray(parsed?.personne)
}

/** Establishments from `listeetablissements` (`{"etablissement": {...} | [...]}`). */
export function getEtablissements(record: BodaccRecord): BodaccEtablissement[] {
	const parsed = parseJsonField<{ etablissement?: BodaccEtablissement | BodaccEtablissement[] }>(
		record.listeetablissements
	)
	return asArray(parsed?.etablissement)
}

export function getJugement(record: BodaccRecord): BodaccJugement | null {
	return parseJsonField<BodaccJugement>(record.jugement)
}

export function getActe(record: BodaccRecord): BodaccActe | null {
	return parseJsonField<BodaccActe>(record.acte)
}

export function getDepot(record: BodaccRecord): BodaccDepot | null {
	return parseJsonField<BodaccDepot>(record.depot)
}

/** SIREN as 9 digits (spaces stripped), from `registre[0]` or the personne's immatriculation. */
export function getSiren(record: BodaccRecord): string | null {
	const fromRegistre = record.registre?.[0]?.replace(/\s/g, '')
	if (fromRegistre && /^\d{9}$/.test(fromRegistre)) return fromRegistre
	for (const p of getPersonnes(record)) {
		const raw = p.numeroImmatriculation?.numeroIdentification?.replace(/\s/g, '')
		if (raw && /^\d{9}$/.test(raw)) return raw
	}
	return null
}

/** Best-effort display name: `commercant` first, then personne morale denomination. */
export function getCompanyName(record: BodaccRecord): string | null {
	if (record.commercant) return record.commercant
	for (const p of getPersonnes(record)) {
		if (p.typePersonne === 'pm' && p.denomination) return p.denomination
	}
	return null
}

// --- EXAMPLE USAGE ---
export async function runExample() {
	console.log('Fetching fresh business creations in Rhône (69) for the current week...')

	const recentCreations = await fetchBodaccLeads({
		category: 'creation',
		department: '69',
		dateFrom: '2026-09-01',
		limit: 5,
	})

	for (const record of recentCreations) {
		const siren = getSiren(record) ?? 'N/A'
		const name = getCompanyName(record) ?? 'Unknown Entity'
		const city = record.ville ?? 'Unknown City'

		console.log(
			`- [SIREN: ${siren}] ${name} located in ${city} (Published: ${record.dateparution})`
		)
	}
}
