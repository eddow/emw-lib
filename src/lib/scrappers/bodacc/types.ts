/**
 * BODACC (Bulletin officiel des annonces civiles et commerciales) types.
 *
 * Verified against the live OpenDataSoft endpoint
 * `bodacc-datadila.opendatasoft.com/.../annonces-commerciales/records`
 * (dataset `annonces-commerciales`, 2026-09-27).
 *
 * Key facts the old types got wrong:
 * - records are FLAT — there is no `annonce.registre` / `annonce['personne morale']`.
 * - `familleavis` holds a CODE (`creation`, `modification`, `vente`, `collective`,
 *   `dpc`, `radiation`, `divers`, ...) — the French label lives in `familleavis_lib`.
 * - the department field is `numerodepartement`, not `departement`.
 * - `parution` is a bulletin number (`20260185`), the publication date is `dateparution`.
 * - `registre` is `string[] | null` (e.g. `["130192529", "130 192 529"]`).
 * - `listepersonnes`, `listeetablissements`, `jugement`, `acte`, ... are
 *   JSON-encoded STRINGS (or null), not nested objects.
 * - `administration` inside a personne morale is free text (`string`), not an array.
 */

/** `familleavis` code as stored by the API. Label is in `familleavis_lib`. */
export type BodaccFamilyCode =
	| 'creation'
	| 'immatriculation'
	| 'modification'
	| 'vente'
	| 'collective'
	| 'conciliation'
	| 'retablissement_professionnel'
	| 'radiation'
	| 'dpc'
	| 'divers'
	| 'inconnue'

/** Backwards-compatible alias. Prefer {@link BodaccFamilyCode}. */
export type BodaccCategory = BodaccFamilyCode

export interface BodaccQueryOptions {
	/** `familleavis` code, e.g. `'creation'` (NOT the French label). */
	category?: BodaccFamilyCode
	/** Department number as string, e.g. `'69'`, `'2A'`. Filters `numerodepartement`. */
	department?: string
	/** Inclusive lower bound on `dateparution`, format `YYYY-MM-DD`. */
	dateFrom?: string
	/** Max records to fetch (default 20). */
	limit?: number
	/** Pagination offset (default 0). */
	offset?: number
}

export interface BodaccImmatriculation {
	numeroIdentification?: string
	codeRCS?: string
	nomGreffeImmat?: string
}

export interface BodaccAddress {
	numeroVoie?: string
	typeVoie?: string
	nomVoie?: string
	complGeographique?: string
	codePostal?: string
	ville?: string
}

export interface BodaccPersonneMorale {
	typePersonne: 'pm'
	numeroImmatriculation?: BodaccImmatriculation
	denomination?: string
	formeJuridique?: string
	capital?: { montantCapital?: string; devise?: string }
	/** Free-text, e.g. `"Gérant : DOE John"`. NOT a structured array. */
	administration?: string
	adresseSiegeSocial?: BodaccAddress
	activite?: string
	/** Extra fields the API may add per category. */
	[key: string]: unknown
}

export interface BodaccPersonnePhysique {
	typePersonne: 'pp'
	numeroImmatriculation?: BodaccImmatriculation
	nom?: string
	/** Usually a string, but the API sometimes returns an array of first names. */
	prenom?: string | string[]
	nomUsage?: string
	nomCommercial?: string
	nationalite?: string
	[key: string]: unknown
}

export type BodaccPersonne = BodaccPersonneMorale | BodaccPersonnePhysique

export interface BodaccEtablissement {
	origineFonds?: string
	qualiteEtablissement?: string
	activite?: string
	adresse?: BodaccAddress
	[key: string]: unknown
}

export interface BodaccJugement {
	type?: string
	famille?: string
	nature?: string
	date?: string
	complementJugement?: string
	[key: string]: unknown
}

export interface BodaccActe {
	dateImmatriculation?: string
	dateCommencementActivite?: string
	descriptif?: string
	creation?: { categorieCreation?: string; [key: string]: unknown }
	vente?: { categorieVente?: string; [key: string]: unknown }
	[key: string]: unknown
}

export interface BodaccDepot {
	dateCloture?: string
	typeDepot?: string
	descriptif?: string
	[key: string]: unknown
}

/** Raw record as returned in `results[]` — flat, with JSON-encoded sub-fields. */
export interface BodaccRecord {
	id: string
	publicationavis?: string | null
	/** Bulletin number, e.g. `"20260185"` — NOT a date. */
	parution?: string | null
	/** Publication date, `YYYY-MM-DD`. */
	dateparution?: string | null
	numeroannonce?: number | null
	typeavis?: string | null
	typeavis_lib?: string | null
	/** Category CODE, e.g. `"creation"`. */
	familleavis?: string | null
	/** Category label, e.g. `"Créations"`. */
	familleavis_lib?: string | null
	numerodepartement?: string | null
	departement_nom_officiel?: string | null
	region_code?: number | null
	region_nom_officiel?: string | null
	tribunal?: string | null
	/** Display name (company denomination or `NOM, Prénom`). Null for `divers`. */
	commercant?: string | null
	ville?: string | null
	/** e.g. `["130192529", "130 192 529"]`. Null for `divers`. */
	registre?: string[] | null
	cp?: string | null
	pdf_parution_subfolder?: number | null
	ispdf_unitaire?: string | null
	/** JSON string like `{"personne": {...}}` (or null). */
	listepersonnes?: string | null
	/** JSON string like `{"etablissement": {...}}` (or null). */
	listeetablissements?: string | null
	/** JSON string (or null). Set for `collective`. */
	jugement?: string | null
	/** JSON string (or null). Set for `creation` / `vente`. */
	acte?: string | null
	/** JSON string (or null). Set for `modification`. */
	modificationsgenerales?: string | null
	/** JSON string (or null). Set for `radiation`. */
	radiationaurcs?: string | null
	/** JSON string (or null). Set for `dpc`. */
	depot?: string | null
	/** JSON string (or null). Set for `vente`. */
	listeprecedentexploitant?: string | null
	/** JSON string (or null). Set for `vente`. */
	listeprecedentproprietaire?: string | null
	/** JSON string (or null). Set for `divers`. */
	divers?: string | null
	parutionavisprecedent?: string | null
	url_complete?: string | null
}

export interface BodaccApiResponse {
	total_count: number
	results: BodaccRecord[]
}
