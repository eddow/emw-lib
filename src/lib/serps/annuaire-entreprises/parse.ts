import type { ListEntry } from '../types.js'

/**
 * Raw company record as returned by the API Recherche d'Entreprises
 * (`GET https://recherche-entreprises.api.gouv.fr/search`).
 * Only the fields mapped to `ListEntry` / `details()` are typed;
 * the API returns much more (finances, complements, ...).
 */
export interface AnnuaireRawCompany {
	siren: string
	nom_complet: string
	nom_raison_sociale: string | null
	sigle: string | null
	activite_principale: string | null
	section_activite_principale: string | null
	nature_juridique: string | null
	categorie_entreprise: string | null
	date_creation: string | null
	date_fermeture: string | null
	etat_administratif: string | null
	tranche_effectif_salarie: string | null
	annee_tranche_effectif_salarie: string | null
	nombre_etablissements: number
	nombre_etablissements_ouverts: number
	siege: {
		adresse: string | null
		code_postal: string | null
		libelle_commune: string | null
		etat_administratif: string | null
		siret: string | null
		latitude: string | null
		longitude: string | null
	} | null
	dirigeants: Array<{
		nom: string | null
		prenoms: string | null
		qualite: string | null
		type_dirigeant: string | null
	}> | null
	tva: { numero: string | null } | null
	[key: string]: unknown
}

export interface AnnuairePage {
	total: number
	limit: number
	page: number
	items: AnnuaireRawCompany[]
}

const FICHE_BASE = 'https://annuaire-entreprises.data.gouv.fr/entreprise'

/**
 * Extract the paginated company list from an API Recherche response.
 * Returns `null` when the shape is not recognised.
 */
export function parseAnnuaireResponse(json: unknown): AnnuairePage | null {
	if (typeof json !== 'object' || json === null) return null
	const r = json as {
		results?: unknown
		total_results?: unknown
		per_page?: unknown
		page?: unknown
	}
	if (!Array.isArray(r.results)) return null
	const total = Number(r.total_results)
	const limit = Number(r.per_page)
	const page = Number(r.page)
	if (!Number.isFinite(total) || !Number.isFinite(limit) || limit <= 0) return null
	return {
		total,
		limit,
		page: Number.isFinite(page) ? page : 1,
		items: r.results as AnnuaireRawCompany[],
	}
}

/** Total page count for an Annuaire result set (NaN when unknown). */
export function annuaireMaxPages(total: number, limit: number): number {
	if (!Number.isFinite(total) || !Number.isFinite(limit) || limit <= 0) return NaN
	return Math.max(1, Math.ceil(total / limit))
}

/** Fiche URL for a company, e.g. `/entreprise/boulangerie-de-paris-352471718`. */
export function annuaireFicheUrl(
	company: Pick<AnnuaireRawCompany, 'siren' | 'nom_complet'>
): string {
	const slug = company.nom_complet
		.toLowerCase()
		.normalize('NFD')
		.replace(/[\u0300-\u036f]/g, '')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
	return `${FICHE_BASE}/${slug || 'entreprise'}-${company.siren}`
}

/** Map one raw API company to a `ListEntry`. */
export function toListEntry(item: AnnuaireRawCompany): ListEntry {
	const entry: ListEntry = {
		title: item.nom_complet,
		id: item.siren,
		url: annuaireFicheUrl(item),
	}
	const siege = item.siege
	if (siege?.adresse) entry.address = siege.adresse
	if (siege?.code_postal) entry.postalCode = siege.code_postal
	if (siege?.libelle_commune) entry.city = siege.libelle_commune
	if (item.activite_principale) entry.naf = item.activite_principale
	if (item.nature_juridique) entry.legalForm = item.nature_juridique
	if (item.date_creation) entry.createdAt = item.date_creation
	if (item.etat_administratif) entry.status = item.etat_administratif
	if (item.tranche_effectif_salarie) entry.workforce = item.tranche_effectif_salarie
	if (item.categorie_entreprise) entry.category = item.categorie_entreprise
	if (Number.isFinite(item.nombre_etablissements)) entry.establishments = item.nombre_etablissements
	return entry
}

/** Map one raw API company to a `details()` record (plain data, no HTML). */
export function toDetails(item: AnnuaireRawCompany): Record<string, unknown> {
	return {
		siren: item.siren,
		name: item.nom_complet,
		tradeName: item.nom_raison_sociale,
		sigle: item.sigle,
		naf: item.activite_principale,
		activitySection: item.section_activite_principale,
		legalForm: item.nature_juridique,
		category: item.categorie_entreprise,
		createdAt: item.date_creation,
		closedAt: item.date_fermeture,
		status: item.etat_administratif,
		workforce: item.tranche_effectif_salarie,
		workforceYear: item.annee_tranche_effectif_salarie,
		establishments: item.nombre_etablissements,
		openEstablishments: item.nombre_etablissements_ouverts,
		headquarters: item.siege
			? {
					address: item.siege.adresse,
					postalCode: item.siege.code_postal,
					city: item.siege.libelle_commune,
					status: item.siege.etat_administratif,
					siret: item.siege.siret,
					latitude: item.siege.latitude,
					longitude: item.siege.longitude,
				}
			: null,
		dirigeants: (item.dirigeants ?? []).map((d) => ({
			name: [d.prenoms, d.nom].filter(Boolean).join(' ') || null,
			role: d.qualite,
			type: d.type_dirigeant,
		})),
		vat: item.tva?.numero ?? null,
		url: annuaireFicheUrl(item),
	}
}
