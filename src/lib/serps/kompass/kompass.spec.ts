import { describe, expect, it } from 'vitest'
import { createKompassAdapter, kompassSearchUrl } from './index.js'
import { parseKompassDetails, parseKompassMaxPages, parseKompassSearchPage } from './parse.js'

const BLOCK = `
<div class="blockNameCompany">
<div class="blockTitle"><h2>
<a class="titleSpan" href="/c/de-benedittis/fr0220871/" name="FR0220871" title="DE BENEDITTIS (SARL DE BENEDITTIS)">DE BENEDITTIS (SARL DE BENEDITTIS)</a>
</h2><span class="tag tagCertif" title="Entreprise certifiée">Certifié</span></div>
<div class="blockTags"><span class="flagWorld"><span class="flag-fr"></span>
<span class="placeText">Paris - France</span></span>
<span class="tiret">-</span>
<span class="tag tagOrange">Producteur</span>
<span class="tag tagOrange">Distributeur</span>
</div>
</div>`

describe('kompassSearchUrl', () => {
	it('builds first-page and paged urls', () => {
		expect(kompassSearchUrl('boulangerie')).toBe(
			'https://fr.kompass.com/searchCompanies?searchType=PRODUCT&text=boulangerie'
		)
		expect(kompassSearchUrl('boulangerie', 2)).toBe(
			'https://fr.kompass.com/searchCompanies/scroll?tab=cmp&pageNbre=2&text=boulangerie'
		)
	})
})

describe('parseKompassSearchPage', () => {
	it('parses a company block', () => {
		const entries = parseKompassSearchPage(`<div>${BLOCK}${BLOCK}</div>`)
		expect(entries).toHaveLength(2)
		const [e] = entries
		expect(e.title).toBe('DE BENEDITTIS (SARL DE BENEDITTIS)')
		expect(e.id).toBe('fr0220871')
		expect(e.url).toBe('https://fr.kompass.com/c/de-benedittis/fr0220871/')
		expect(e.city).toBe('Paris')
		expect(e.country).toBe('France')
		expect(e.roles).toEqual(['Producteur', 'Distributeur'])
		expect(e.certified).toBe(true)
	})

	it('skips blocks without company anchor', () => {
		expect(parseKompassSearchPage('<div>no companies</div>')).toEqual([])
	})
})

describe('parseKompassMaxPages', () => {
	it('reads the cmp pager', () => {
		expect(
			parseKompassMaxPages(
				'<a href="/searchCompanies/scroll?tab=cmp&pageNbre=10">10</a><a href="/searchCompanies/scroll?tab=pp&pageNbre=8">8</a>'
			)
		).toBe(10)
	})

	it('returns NaN when unknown', () => {
		expect(parseKompassMaxPages('<div>no pager</div>')).toBeNaN()
	})
})

describe('parseKompassDetails', () => {
	it('reads the organization JSON-LD', () => {
		const html = `<script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","name":"Inoxpa","telephone":"+33 1 43 34 34 34","address":{"@type":"PostalAddress","streetAddress":"C/ Telers, 60","postalCode":"17820","addressLocality":"Banyoles","addressCountry":"ES"}}</script>`
		const d = parseKompassDetails(html, 'https://fr.kompass.com/c/inoxpa-s-a-u/es0017716/')
		expect(d.name).toBe('Inoxpa')
		expect(d.phone).toBe('+33 1 43 34 34 34')
		expect(d.city).toBe('Banyoles')
		expect(d.id).toBe('es0017716')
	})

	it('falls back to tel: links', () => {
		const d = parseKompassDetails(
			'<a href="tel:01 43 34 34 34">call</a>',
			'https://fr.kompass.com/c/x/fr1/'
		)
		expect(d.phone).toBe('01 43 34 34 34')
	})
})

describe('kompass adapter', () => {
	it('paginates through mocked fetch', async () => {
		const html = `<div>${BLOCK}</div><a href="/searchCompanies/scroll?tab=cmp&pageNbre=10">10</a>`
		const seen: string[] = []
		const fetchFn = (async (url: string | URL | Request) => {
			seen.push(String(url))
			return new Response(html, { status: 200 })
		}) as typeof fetch
		const adapter = createKompassAdapter(fetchFn)
		expect(adapter.name).toBe('kompass')
		const paginator = await adapter.search('boulangerie')
		const entries = await paginator.page(1)
		expect(entries).toHaveLength(1)
		expect(paginator.maxPages).toBe(10)
		expect(seen[0]).toBe(
			'https://fr.kompass.com/searchCompanies?searchType=PRODUCT&text=boulangerie'
		)
		await expect(paginator.page(11)).rejects.toThrow(RangeError)
		await expect(paginator.page(0)).rejects.toThrow(RangeError)
	})

	it('fetches details by company url', async () => {
		const seen: string[] = []
		const fetchFn = (async (url: string | URL | Request) => {
			seen.push(String(url))
			return new Response('<a href="tel:0143343434">call</a>', { status: 200 })
		}) as typeof fetch
		const adapter = createKompassAdapter(fetchFn)
		const d = await adapter.details!('https://fr.kompass.com/c/inoxpa-s-a-u/es0017716/')
		expect(d.phone).toBe('0143343434')
		expect(seen[0]).toBe('https://fr.kompass.com/c/inoxpa-s-a-u/es0017716/')
	})

	it('rejects empty search terms', async () => {
		const adapter = createKompassAdapter(async () => new Response('', { status: 200 }))
		await expect(adapter.search('  ')).rejects.toThrow()
	})

	it('throws on http error', async () => {
		const adapter = createKompassAdapter(async () => new Response('nope', { status: 403 }))
		await expect((await adapter.search('x')).page(1)).rejects.toThrow(/403/)
	})
})
