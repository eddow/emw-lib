import { describe, expect, it, vi } from 'vitest'
import {
	buildBodaccUrl,
	fetchBodaccLeads,
	getActe,
	getCompanyName,
	getDepot,
	getEtablissements,
	getJugement,
	getPersonnes,
	getSiren,
	parseJsonField,
} from './client.js'
import type { BodaccRecord } from './types.js'

// ---------------------------------------------------------------------------
// Fixtures: faithful copies of raw records returned by the live OpenDataSoft
// endpoint on 2026-09-27 (dataset `annonces-commerciales`).
// `listepersonnes` / `listeetablissements` / `acte` / ... arrive as
// JSON-encoded STRINGS (or null) — never as nested objects.
// ---------------------------------------------------------------------------

const CREATION_PP: BodaccRecord = {
	id: 'A2026018518',
	publicationavis: 'A',
	parution: '20260185',
	dateparution: '2026-09-27',
	numeroannonce: 18,
	typeavis: 'annonce',
	typeavis_lib: 'Avis initial',
	familleavis: 'creation',
	familleavis_lib: 'Créations',
	numerodepartement: '06',
	departement_nom_officiel: 'Alpes-Maritimes',
	region_code: 93,
	region_nom_officiel: "Provence-Alpes-Côte d'Azur",
	tribunal: 'Greffe du Tribunal de Commerce de Cannes',
	commercant: 'LARABI, Ramzi',
	ville: 'Cannes',
	registre: ['952517449', '952 517 449'],
	cp: '06150',
	listepersonnes: JSON.stringify({
		personne: {
			typePersonne: 'pp',
			numeroImmatriculation: {
				numeroIdentification: '952 517 449',
				codeRCS: 'RCS',
				nomGreffeImmat: 'Cannes',
			},
			nom: 'LARABI',
			prenom: 'Ramzi',
			nationalite: 'Française',
		},
	}),
	listeetablissements: JSON.stringify({
		etablissement: {
			origineFonds: 'Création',
			qualiteEtablissement: 'établissement principal',
			activite: 'vente à distance sur catalogue spécialisé',
			adresse: {
				numeroVoie: '68',
				typeVoie: 'Chemin',
				nomVoie: 'des Gourguettes',
				codePostal: '06150',
				ville: 'Cannes',
			},
		},
	}),
	jugement: null,
	acte: JSON.stringify({
		dateImmatriculation: '2026-09-23',
		dateCommencementActivite: '2026-09-09',
		creation: {
			categorieCreation:
				"Immatriculation d'une personne physique suite à création d'un établissement principal",
		},
	}),
	modificationsgenerales: null,
	radiationaurcs: null,
	depot: null,
	listeprecedentexploitant: null,
	listeprecedentproprietaire: null,
	divers: null,
	parutionavisprecedent: null,
	url_complete: 'https://www.bodacc.fr/pages/annonces-commerciales-detail/?q.id=id:A2026018518',
}

const CREATION_PM: BodaccRecord = {
	id: 'A2026018571',
	publicationavis: 'A',
	parution: '20260185',
	dateparution: '2026-09-27',
	numeroannonce: 71,
	typeavis: 'annonce',
	typeavis_lib: 'Avis initial',
	familleavis: 'creation',
	familleavis_lib: 'Créations',
	numerodepartement: '06',
	departement_nom_officiel: 'Alpes-Maritimes',
	region_code: 93,
	region_nom_officiel: "Provence-Alpes-Côte d'Azur",
	tribunal: 'Greffe du Tribunal de Commerce de Grasse',
	commercant: 'YARON',
	ville: 'Valbonne',
	registre: ['130192529', '130 192 529'],
	cp: '06560',
	listepersonnes: JSON.stringify({
		personne: {
			typePersonne: 'pm',
			numeroImmatriculation: {
				numeroIdentification: '130 192 529',
				codeRCS: 'RCS',
				nomGreffeImmat: 'Grasse',
			},
			denomination: 'YARON',
			formeJuridique: 'Société Civile Immobilière',
			capital: { montantCapital: '1000.00', devise: 'EUR' },
			administration: 'Gérant : FLAJSZAKER Michael David nom d’usage : FLAJSZAKER',
			adresseSiegeSocial: {
				numeroVoie: '367',
				typeVoie: 'Route',
				nomVoie: "D'Opio",
				codePostal: '06560',
				ville: 'Valbonne',
			},
		},
	}),
	listeetablissements: JSON.stringify({
		etablissement: { activite: 'acquisition, construction ou location de biens immobiliers' },
	}),
	jugement: null,
	acte: JSON.stringify({
		dateCommencementActivite: '2026-06-25',
		creation: {
			categorieCreation:
				"Immatriculation d'une personne morale (B, C, D) suite à création d'un établissement principal",
		},
	}),
	modificationsgenerales: null,
	radiationaurcs: null,
	depot: null,
	listeprecedentexploitant: null,
	listeprecedentproprietaire: null,
	divers: null,
	parutionavisprecedent: null,
	url_complete: 'https://www.bodacc.fr/pages/annonces-commerciales-detail/?q.id=id:A2026018571',
}

/** `prenom` sometimes arrives as an ARRAY of first names (live case: BEN DIN, Lukas, Theo). */
const CREATION_PP_MULTI_PRENOM: BodaccRecord = {
	...CREATION_PP,
	id: 'A2026018539',
	commercant: 'BEN DIN, Lukas, Theo',
	registre: ['109997544', '109 997 544'],
	listepersonnes: JSON.stringify({
		personne: {
			typePersonne: 'pp',
			numeroImmatriculation: {
				numeroIdentification: '109 997 544',
				codeRCS: 'RCS',
				nomGreffeImmat: 'Grasse',
			},
			nom: 'BEN DIN',
			prenom: ['Lukas', 'Theo'],
			nomUsage: 'BEN DIN',
			nomCommercial: 'Nova Collect',
		},
	}),
}

const COLLECTIVE: BodaccRecord = {
	...CREATION_PP,
	id: 'A202601852758',
	familleavis: 'collective',
	familleavis_lib: 'Procédures collectives',
	numerodepartement: '59',
	commercant: 'KATIA MOTOS',
	registre: ['838446524', '838 446 524'],
	listepersonnes: JSON.stringify({
		personne: {
			typePersonne: 'pm',
			numeroImmatriculation: {
				numeroIdentification: '838 446 524',
				codeRCS: 'RCS',
				nomGreffeImmat: 'Douai',
			},
			denomination: 'KATIA MOTOS',
			activite: 'Commerce et réparation de motocycles',
			formeJuridique: 'Société par actions simplifiée',
			adresseSiegeSocial: {
				numeroVoie: '4',
				typeVoie: 'rue',
				nomVoie: 'Pasteur',
				codePostal: '59730',
				ville: 'Saint-Python',
			},
		},
	}),
	listeetablissements: null,
	jugement: JSON.stringify({
		type: 'initial',
		famille: 'Jugement de clôture',
		nature: "Jugement de clôture pour insuffisance d'actif",
		date: '2026-09-23',
		complementJugement:
			'Jugement prononçant la clôture de la procédure de liquidation judiciaire pour insuffisance d’actif.',
	}),
	acte: null,
}

const MODIFICATION: BodaccRecord = {
	...CREATION_PP,
	id: 'B2026018581',
	publicationavis: 'B',
	familleavis: 'modification',
	familleavis_lib: 'Modifications diverses',
	numerodepartement: '05',
	commercant: 'KINTZ FRERES',
	ville: null,
	registre: ['393553235', '393 553 235'],
	cp: null,
	listepersonnes: JSON.stringify({
		personne: {
			typePersonne: 'pm',
			numeroImmatriculation: {
				numeroIdentification: '393 553 235',
				codeRCS: 'RCS',
				nomGreffeImmat: 'Gap',
			},
			denomination: 'KINTZ FRERES',
			formeJuridique: 'Société par Actions Simplifiée',
			administration: 'Sté par actions simplifiée Audit Plus devient commissaire aux comptes',
		},
	}),
	listeetablissements: null,
	acte: null,
	modificationsgenerales: JSON.stringify({ descriptif: "Modification de l'administration." }),
}

const VENTE: BodaccRecord = {
	...CREATION_PP,
	id: 'A20260185239',
	familleavis: 'vente',
	familleavis_lib: 'Ventes et cessions',
	numerodepartement: '13',
	commercant: 'GM2T, WEDLOK',
	registre: ['103823035', '103 823 035'],
	listepersonnes: JSON.stringify({
		personne: {
			typePersonne: 'pm',
			numeroImmatriculation: {
				numeroIdentification: '103 823 035',
				codeRCS: 'RCS',
				nomGreffeImmat: 'Tarascon',
			},
			denomination: 'GM2T',
			formeJuridique: 'Société par Actions Simplifiée',
		},
	}),
	listeetablissements: JSON.stringify({
		etablissement: {
			origineFonds: 'Etablissement secondaire acquis par achat au prix stipulé de 30000 EUR',
			qualiteEtablissement: 'Etablissement secondaire',
			activite: 'La location et location-bail de matériel évènementiel',
		},
	}),
	acte: JSON.stringify({
		descriptif: 'Acte sous seing privé en date du 02/05/2026',
		dateCommencementActivite: '2026-05-02',
		vente: { categorieVente: "Achat d'un établissement secondaire ou complémentaire" },
	}),
	listeprecedentproprietaire: JSON.stringify({
		personne: {
			typePersonne: 'pm',
			numeroImmatriculation: {
				numeroIdentification: '977 668 284',
				codeRCS: 'RCS',
				nomGreffeImmat: 'Salon de Provence',
			},
			denomination: 'WEDLOK',
		},
	}),
}

const RADIATION: BodaccRecord = {
	...CREATION_PP,
	id: 'B202601858',
	publicationavis: 'B',
	familleavis: 'radiation',
	familleavis_lib: 'Radiations',
	numerodepartement: '02',
	commercant: 'DE LA PLEINE LUNE (G.A.E.C.)',
	registre: ['316969237', '316 969 237'],
	listepersonnes: JSON.stringify({
		personne: {
			typePersonne: 'pm',
			numeroImmatriculation: {
				numeroIdentification: '316 969 237',
				codeRCS: 'RCS',
				nomGreffeImmat: 'Saint-Quentin',
			},
			denomination: 'DE LA PLEINE LUNE (G.A.E.C.)',
			formeJuridique: "Groupement agricole d'exploitation en commun",
			capital: { montantCapital: '88420.43', devise: 'EUR' },
		},
	}),
	acte: null,
	radiationaurcs: JSON.stringify({ commentaire: "Radiation d'office" }),
}

const DIVERS: BodaccRecord = {
	id: 'A202501042956',
	publicationavis: 'A',
	parution: '20250104',
	dateparution: '2025-04-03',
	numeroannonce: 2956,
	typeavis: 'annonce',
	typeavis_lib: 'Avis initial',
	familleavis: 'divers',
	familleavis_lib: 'Annonces diverses',
	numerodepartement: null,
	departement_nom_officiel: null,
	region_code: null,
	region_nom_officiel: null,
	tribunal: null,
	commercant: null,
	ville: null,
	registre: null,
	cp: null,
	listepersonnes: null,
	listeetablissements: null,
	jugement: null,
	acte: null,
	modificationsgenerales: null,
	radiationaurcs: null,
	depot: null,
	listeprecedentexploitant: null,
	listeprecedentproprietaire: null,
	divers: JSON.stringify({
		titreAnnonce: 'CONVOCATION À PROCEDURE DE DISTRIBUTION DU PRIX',
		contenuAnnonce: 'ADJUDICATEUR : SARL MY HOLDING - POURSUIVANT : SARL AIR INVEST',
	}),
	parutionavisprecedent: null,
	url_complete: 'https://www.bodacc.fr/pages/annonces-commerciales-detail/?q.id=id:A202501042956',
}

const DPC_DEPOT_RAW =
	'{"dateCloture": "2024-08-31", "typeDepot": "Comptes annuels et rapports", "descriptif": "confidentialité (art. L. 232-25)."}'

// ---------------------------------------------------------------------------

describe('buildBodaccUrl', () => {
	it('filters on the familleavis CODE by default (not the French label)', () => {
		const where = new URL(buildBodaccUrl()).searchParams.get('where')
		expect(where).toBe('familleavis = "creation"')
	})

	it('uses numerodepartement and dateparution field names', () => {
		const url = buildBodaccUrl({ category: 'creation', department: '69', dateFrom: '2026-09-01' })
		const where = new URL(url).searchParams.get('where')
		expect(where).toBe(
			'familleavis = "creation" AND numerodepartement = "69" AND dateparution >= "2026-09-01"'
		)
		// The old (broken) field name / label must never appear as a standalone filter.
		expect(where).not.toMatch(/(^|[\s(])departement\s*=/)
		expect(url).not.toContain('Cr%C3%A9ations')
	})

	it('supports every observed familleavis code and pagination', () => {
		const url = buildBodaccUrl({ category: 'dpc', limit: 100, offset: 40 })
		const params = new URL(url).searchParams
		expect(params.get('where')).toBe('familleavis = "dpc"')
		expect(params.get('limit')).toBe('100')
		expect(params.get('offset')).toBe('40')
		expect(params.get('order_by')).toBe('dateparution DESC')
	})
})

describe('raw record shape (live payload 2026-09-27)', () => {
	it('is flat — there is no annonce wrapper', () => {
		for (const r of [CREATION_PP, CREATION_PM, COLLECTIVE, VENTE]) {
			expect(r).not.toHaveProperty('annonce')
			expect(r).not.toHaveProperty('departement')
			expect(r).not.toHaveProperty('region')
			expect(typeof r.id).toBe('string')
		}
	})

	it('parution is a bulletin number, dateparution is the publication date', () => {
		expect(CREATION_PP.parution).toBe('20260185')
		expect(CREATION_PP.parution).not.toMatch(/^\d{4}-\d{2}-\d{2}$/)
		expect(CREATION_PP.dateparution).toMatch(/^\d{4}-\d{2}-\d{2}$/)
	})

	it('registre is an array of [plain, spaced] SIREN', () => {
		expect(CREATION_PM.registre).toEqual(['130192529', '130 192 529'])
	})

	it('parses a personne physique creation', () => {
		const [p] = getPersonnes(CREATION_PP)
		expect(p.typePersonne).toBe('pp')
		if (p.typePersonne !== 'pp') throw new Error('expected pp')
		expect(p.nom).toBe('LARABI')
		expect(p.prenom).toBe('Ramzi')
		expect(p.numeroImmatriculation?.numeroIdentification).toBe('952 517 449')
		expect(p.numeroImmatriculation?.nomGreffeImmat).toBe('Cannes')
	})

	it('parses a personne morale creation: administration is free text, not an array', () => {
		const [p] = getPersonnes(CREATION_PM)
		expect(p.typePersonne).toBe('pm')
		if (p.typePersonne !== 'pm') throw new Error('expected pm')
		expect(p.denomination).toBe('YARON')
		expect(p.formeJuridique).toBe('Société Civile Immobilière')
		expect(p.capital).toEqual({ montantCapital: '1000.00', devise: 'EUR' })
		expect(typeof p.administration).toBe('string')
		expect(p.administration).toContain('Gérant')
		expect(p.adresseSiegeSocial?.ville).toBe('Valbonne')
	})

	it('supports prenom as an array of first names', () => {
		const [p] = getPersonnes(CREATION_PP_MULTI_PRENOM)
		if (p.typePersonne !== 'pp') throw new Error('expected pp')
		expect(p.prenom).toEqual(['Lukas', 'Theo'])
	})

	it('parses etablissement + acte for creations', () => {
		const [e] = getEtablissements(CREATION_PP)
		expect(e.origineFonds).toBe('Création')
		expect(e.qualiteEtablissement).toBe('établissement principal')
		expect(e.adresse?.ville).toBe('Cannes')
		const acte = getActe(CREATION_PP)
		expect(acte?.dateImmatriculation).toBe('2026-09-23')
		expect(acte?.creation?.categorieCreation).toContain('personne physique')
	})

	it('parses jugement for procedures collectives', () => {
		const jugement = getJugement(COLLECTIVE)
		expect(jugement?.famille).toBe('Jugement de clôture')
		expect(jugement?.nature).toContain('insuffisance')
		expect(jugement?.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
		expect(getJugement(CREATION_PP)).toBeNull()
	})

	it('parses modificationsgenerales for modifications', () => {
		expect(parseJsonField<{ descriptif: string }>(MODIFICATION.modificationsgenerales)).toEqual({
			descriptif: "Modification de l'administration.",
		})
		expect(MODIFICATION.ville).toBeNull()
		expect(MODIFICATION.cp).toBeNull()
	})

	it('parses vente acte + previous owner', () => {
		const acte = getActe(VENTE)
		expect(acte?.vente?.categorieVente).toContain('secondaire')
		const prev = parseJsonField<{ personne: { denomination: string } }>(
			VENTE.listeprecedentproprietaire
		)
		expect(prev?.personne.denomination).toBe('WEDLOK')
		const [e] = getEtablissements(VENTE)
		expect(e.origineFonds).toContain('30000 EUR')
	})

	it('parses radiation + depot payloads', () => {
		expect(parseJsonField<{ commentaire: string }>(RADIATION.radiationaurcs)).toEqual({
			commentaire: "Radiation d'office",
		})
		expect(getDepot({ ...RADIATION, depot: DPC_DEPOT_RAW })?.typeDepot).toBe(
			'Comptes annuels et rapports'
		)
	})

	it('divers records carry no company fields', () => {
		expect(DIVERS.registre).toBeNull()
		expect(DIVERS.commercant).toBeNull()
		expect(DIVERS.ville).toBeNull()
		expect(DIVERS.numerodepartement).toBeNull()
		expect(getPersonnes(DIVERS)).toEqual([])
		expect(getSiren(DIVERS)).toBeNull()
		const divers = parseJsonField<{ titreAnnonce: string }>(DIVERS.divers)
		expect(divers?.titreAnnonce).toContain('CONVOCATION')
	})

	it('parseJsonField returns null on missing/invalid input', () => {
		expect(parseJsonField(null)).toBeNull()
		expect(parseJsonField(undefined)).toBeNull()
		expect(parseJsonField('not-json{{{')).toBeNull()
	})
})

describe('getSiren / getCompanyName', () => {
	it('returns the 9-digit SIREN with spaces stripped', () => {
		expect(getSiren(CREATION_PP)).toBe('952517449')
		expect(getSiren(CREATION_PM)).toBe('130192529')
		expect(getSiren(RADIATION)).toBe('316969237')
	})

	it('falls back to the personne immatriculation when registre is missing', () => {
		expect(getSiren({ ...CREATION_PP, registre: null })).toBe('952517449')
	})

	it('prefers commercant, then personne morale denomination', () => {
		expect(getCompanyName(CREATION_PM)).toBe('YARON')
		expect(getCompanyName({ ...CREATION_PM, commercant: null })).toBe('YARON')
		expect(getCompanyName(DIVERS)).toBeNull()
	})
})

describe('fetchBodaccLeads (mocked fetch)', () => {
	it('requests the right URL and returns results', async () => {
		const seen: string[] = []
		const fetchFn = vi.fn(async (url: string) => {
			seen.push(url)
			return { ok: true, json: async () => ({ total_count: 1, results: [CREATION_PM] }) }
		})
		const results = await fetchBodaccLeads({ department: '69' }, fetchFn as unknown as typeof fetch)
		expect(results).toHaveLength(1)
		expect(results[0].id).toBe('A2026018571')
		expect(fetchFn).toHaveBeenCalledOnce()
		const where = new URL(seen[0]).searchParams.get('where')
		expect(where).toContain('familleavis = "creation"')
		expect(where).toContain('numerodepartement = "69"')
	})

	it('throws on HTTP errors', async () => {
		const bad = vi.fn(async () => ({ ok: false, status: 400, statusText: 'Bad Request' }))
		await expect(fetchBodaccLeads({}, bad as unknown as typeof fetch)).rejects.toThrow(
			'BODACC API error: 400'
		)
	})
})

describe('live BODACC API (reads raw returned data)', () => {
	it('creations match the typed shape', { timeout: 30_000 }, async () => {
		const results = await fetchBodaccLeads({ category: 'creation', limit: 3 })
		expect(results.length).toBeGreaterThan(0)
		expect(results.length).toBeLessThanOrEqual(3)
		for (const r of results) {
			expect(typeof r.id).toBe('string')
			expect(r.familleavis).toBe('creation')
			expect(r.dateparution).toMatch(/^\d{4}-\d{2}-\d{2}$/)
			// Flat shape: no annonce wrapper (the old types were wrong here).
			expect(r).not.toHaveProperty('annonce')
			const siren = getSiren(r)
			expect(siren === null || /^\d{9}$/.test(siren)).toBe(true)
			// Sub-fields must be JSON strings (or null), parseable when present.
			if (r.listepersonnes != null) {
				expect(typeof r.listepersonnes).toBe('string')
				expect(getPersonnes(r).length).toBeGreaterThan(0)
			}
		}
	})

	it('dpc records carry a depot payload', { timeout: 30_000 }, async () => {
		const results = await fetchBodaccLeads({ category: 'dpc', limit: 2 })
		expect(results.length).toBeGreaterThan(0)
		for (const r of results) {
			expect(r.familleavis).toBe('dpc')
			if (r.depot != null) {
				expect(getDepot(r)?.typeDepot).toBeTruthy()
			}
		}
	})
})
