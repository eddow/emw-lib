import { describe, expect, it } from 'vitest'
import { annuaireCompanyUrl, annuaireSearchUrl, createAnnuaireAdapter } from './index.js'
import {
	annuaireFicheUrl,
	annuaireMaxPages,
	parseAnnuaireResponse,
	toDetails,
	toListEntry,
} from './parse.js'

const COMPANY = {
	siren: '352471718',
	nom_complet: 'BOULANGERIE DE PARIS',
	nom_raison_sociale: 'BOULANGERIE DE PARIS',
	sigle: null,
	activite_principale: '10.71C',
	section_activite_principale: 'C',
	nature_juridique: '5710',
	categorie_entreprise: 'PME',
	date_creation: '1989-11-21',
	date_fermeture: null,
	etat_administratif: 'A',
	tranche_effectif_salarie: '12',
	annee_tranche_effectif_salarie: '2023',
	nombre_etablissements: 3,
	nombre_etablissements_ouverts: 3,
	siege: {
		adresse: '16-18 16 PLACE MORNY 14800 DEAUVILLE',
		code_postal: '14800',
		libelle_commune: 'DEAUVILLE',
		etat_administratif: 'A',
		siret: '35247171800010',
		latitude: '49.359888977117',
		longitude: '0.0768723889525658',
	},
	dirigeants: [
		{
			nom: 'DESREE',
			prenoms: 'JULIEN NICOLAS JEAN',
			qualite: 'Président de SAS',
			type_dirigeant: 'personne physique',
		},
	],
	tva: { numero: 'FR27352471718' },
}

function response(total: number, per_page: number, page: number, results: unknown[]) {
	return { results, total_results: total, per_page, page, total_pages: 50 }
}

describe('annuaireSearchUrl', () => {
	it('builds first-page and paged urls', () => {
		expect(annuaireSearchUrl('boulangerie paris')).toBe(
			'https://recherche-entreprises.api.gouv.fr/search?q=boulangerie+paris&page=1&per_page=20'
		)
		expect(annuaireSearchUrl('boulangerie', 3)).toBe(
			'https://recherche-entreprises.api.gouv.fr/search?q=boulangerie&page=3&per_page=20'
		)
	})

	it('builds the company url', () => {
		expect(annuaireCompanyUrl('352471718')).toBe(
			'https://recherche-entreprises.api.gouv.fr/search?q=352471718&page=1&per_page=1'
		)
	})
})

describe('parseAnnuaireResponse', () => {
	it('extracts the results block', () => {
		const parsed = parseAnnuaireResponse(response(985, 20, 1, [COMPANY]))
		expect(parsed).not.toBeNull()
		expect(parsed!.total).toBe(985)
		expect(parsed!.limit).toBe(20)
		expect(parsed!.page).toBe(1)
		expect(parsed!.items).toHaveLength(1)
	})

	it('returns null on unexpected shapes', () => {
		expect(parseAnnuaireResponse(null)).toBeNull()
		expect(parseAnnuaireResponse({})).toBeNull()
		expect(parseAnnuaireResponse({ results: [], total_results: 1 })).toBeNull()
	})
})

describe('annuaireMaxPages', () => {
	it('ceil-divides total by limit', () => {
		expect(annuaireMaxPages(985, 20)).toBe(50)
		expect(annuaireMaxPages(21, 40)).toBe(1)
	})

	it('returns NaN when unknown', () => {
		expect(annuaireMaxPages(NaN, 20)).toBeNaN()
		expect(annuaireMaxPages(10, 0)).toBeNaN()
	})
})

describe('toListEntry', () => {
	it('maps a raw company', () => {
		const e = toListEntry(COMPANY as never)
		expect(e.title).toBe('BOULANGERIE DE PARIS')
		expect(e.id).toBe('352471718')
		expect(e.url).toBe(
			'https://annuaire-entreprises.data.gouv.fr/entreprise/boulangerie-de-paris-352471718'
		)
		expect(e.address).toBe('16-18 16 PLACE MORNY 14800 DEAUVILLE')
		expect(e.city).toBe('DEAUVILLE')
		expect(e.naf).toBe('10.71C')
	})

	it('builds an ascii slug fiche url', () => {
		expect(annuaireFicheUrl({ siren: '123456789', nom_complet: "L'Été à Paris!" })).toBe(
			'https://annuaire-entreprises.data.gouv.fr/entreprise/l-ete-a-paris-123456789'
		)
	})
})

describe('toDetails', () => {
	it('maps dirigeants and headquarters', () => {
		const d = toDetails(COMPANY as never)
		expect(d.siren).toBe('352471718')
		expect(d.vat).toBe('FR27352471718')
		expect(d.dirigeants).toEqual([
			{ name: 'JULIEN NICOLAS JEAN DESREE', role: 'Président de SAS', type: 'personne physique' },
		])
		expect(d.headquarters).toMatchObject({ city: 'DEAUVILLE', siret: '35247171800010' })
	})
})

describe('annuaire adapter', () => {
	const fakeFetch = (payload: unknown, status = 200) => {
		return (async () => new Response(JSON.stringify(payload), { status })) as typeof fetch
	}

	it('paginates through mocked fetch', async () => {
		const seen: string[] = []
		const fetchFn = (async (url: string | URL | Request) => {
			seen.push(String(url))
			return new Response(JSON.stringify(response(985, 20, 1, [COMPANY])), { status: 200 })
		}) as typeof fetch
		const adapter = createAnnuaireAdapter(fetchFn)
		expect(adapter.name).toBe('annuaire-entreprises')
		const paginator = await adapter.search('boulangerie paris')
		const entries = await paginator.page(1)
		expect(entries).toHaveLength(1)
		expect(entries[0].id).toBe('352471718')
		expect(paginator.maxPages).toBe(50)
		expect(seen[0]).toBe(
			'https://recherche-entreprises.api.gouv.fr/search?q=boulangerie+paris&page=1&per_page=20'
		)
		await expect(paginator.page(51)).rejects.toThrow(RangeError)
		await expect(paginator.page(0)).rejects.toThrow(RangeError)
	})

	it('fetches details by SIREN', async () => {
		const adapter = createAnnuaireAdapter(fakeFetch(response(1, 1, 1, [COMPANY])))
		const d = await adapter.details!('352471718')
		expect(d.name).toBe('BOULANGERIE DE PARIS')
		await expect(adapter.details!('123')).rejects.toThrow(/9-digit SIREN/)
	})

	it('rejects empty search terms', async () => {
		const adapter = createAnnuaireAdapter(fakeFetch({}))
		await expect(adapter.search('  ')).rejects.toThrow()
	})

	it('throws on http error and on unexpected shape', async () => {
		const bad = createAnnuaireAdapter(fakeFetch('nope', 503))
		await expect((await bad.search('x')).page(1)).rejects.toThrow(/503/)
		const shapeless = createAnnuaireAdapter(fakeFetch({}))
		await expect((await shapeless.search('x')).page(1)).rejects.toThrow(/unexpected response/)
	})
})
