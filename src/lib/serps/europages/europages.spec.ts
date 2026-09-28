import { describe, expect, it } from 'vitest'
import { createEuropagesAdapter, europagesSearchUrl } from './index.js'
import {
	parseEuropagesDetails,
	parseEuropagesMaxPages,
	parseEuropagesSearchPage,
	parseTile,
} from './parse.js'

const LD_JSON = `<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"BreadcrumbList","itemListElement":[{"@type":"ListItem","position":1,"name":"Home"}]},{"@type":"ItemList","name":"boulangerie","itemListElement":[{"@type":"ListItem","position":1,"item":{"@type":"Organization","@id":"https://www.europages.fr/fr/company/spsi-22277465#organization","name":"SPSI","url":"https://www.europages.fr/fr/company/spsi-22277465","address":{"@type":"PostalAddress","addressLocality":"Collégien","addressCountry":"FR"},"areaServed":"international","numberOfEmployees":{"@type":"QuantitativeValue","value":"20-49"}}},{"@type":"ListItem","position":2,"item":{"@type":"Organization","@id":"https://www.europages.fr/AIGREMONT/BEL008585-001.html#organization","name":"AIGREMONT","url":"https://www.europages.fr/AIGREMONT/BEL008585-001.html","address":{"@type":"PostalAddress","addressLocality":"Awirs-Flemalle","addressCountry":"BE"},"areaServed":"europe","numberOfEmployees":{"@type":"QuantitativeValue","value":"50-99"}}}]}]}</script>`

const TILE = `
<div class="company-tile" data-test="company" data-scroll-restoration="company-tile-22277465">
<a href="/fr/company/spsi-22277465" data-test="company-logo"><img src="https://example.com/logo.png" alt="Logo" /></a>
<a href="/fr/company/spsi-22277465" data-test="company-name"><h2>SPSI</h2></a>
<div data-test="company-facts"><div data-test="employee-count"><div>20-49</div></div></div>
<div><span>France</span>, <span class="city">Collégien</span></div>
<div>Livraison: Mondiale</div>
<div data-test="supplier-types"><span>Fabricant/Producteur</span></div>
<div data-test="description">Concepteur de matériel pour la boulangerie.</div>
</div>`

describe('europagesSearchUrl', () => {
	it('builds first-page and paged urls', () => {
		expect(europagesSearchUrl('boulangerie')).toBe(
			'https://www.europages.fr/entreprises/boulangerie.html'
		)
		expect(europagesSearchUrl('Boulangerie Patisserie', 2)).toBe(
			'https://www.europages.fr/entreprises/pg-2/boulangerie-patisserie.html'
		)
	})
})

describe('parseEuropagesSearchPage', () => {
	it('prefers the JSON-LD ItemList', () => {
		const entries = parseEuropagesSearchPage(`<html><head>${LD_JSON}</head><body></body></html>`)
		expect(entries).toHaveLength(2)
		const [spsi, aigremont] = entries
		expect(spsi.title).toBe('SPSI')
		expect(spsi.id).toBe('22277465')
		expect(spsi.url).toBe('https://www.europages.fr/fr/company/spsi-22277465')
		expect(spsi.country).toBe('FR')
		expect(spsi.city).toBe('Collégien')
		expect(spsi.workforce).toBe('20-49')
		expect(spsi.deliveryArea).toBe('international')
		expect(aigremont.id).toBe('008585')
		expect(aigremont.url).toBe('https://www.europages.fr/AIGREMONT/BEL008585-001.html')
	})

	it('merges HTML tile extras into JSON-LD entries', () => {
		const entries = parseEuropagesSearchPage(
			`<html><head>${LD_JSON}</head><body>${TILE}</body></html>`
		)
		expect(entries[0].thumbnail).toBe('https://example.com/logo.png')
		expect(entries[0].supplierTypes).toEqual(['Fabricant/Producteur'])
		expect(entries[0].description).toBe('Concepteur de matériel pour la boulangerie.')
	})

	it('falls back to HTML tiles without JSON-LD', () => {
		const entries = parseEuropagesSearchPage(`<div>${TILE}</div>`)
		expect(entries).toHaveLength(1)
		expect(entries[0].title).toBe('SPSI')
		expect(entries[0].url).toBe('https://www.europages.fr/fr/company/spsi-22277465')
	})

	it('returns [] without data', () => {
		expect(parseEuropagesSearchPage('<div>no companies</div>')).toEqual([])
	})
})

describe('parseTile', () => {
	it('parses legacy href formats', () => {
		const legacy = TILE.replaceAll(
			'/fr/company/spsi-22277465',
			'/AIGREMONT/BEL008585-001.html'
		).replace('company-tile-22277465', 'company-tile-008585')
		const e = parseTile(legacy)!
		expect(e.id).toBe('008585')
		expect(e.url).toBe('https://www.europages.fr/AIGREMONT/BEL008585-001.html')
	})
})

describe('parseEuropagesMaxPages', () => {
	it('reads search-results totalpages', () => {
		expect(
			parseEuropagesMaxPages('<div data-test="search-results" total="7035" totalpages="235">')
		).toBe(235)
	})

	it('falls back to pg-N links', () => {
		expect(parseEuropagesMaxPages('<a href="/entreprises/pg-10/boulangerie.html">10</a>')).toBe(10)
	})

	it('returns NaN when unknown', () => {
		expect(parseEuropagesMaxPages('<div>no pager</div>')).toBeNaN()
	})
})

describe('parseEuropagesDetails', () => {
	it('reads the company JSON-LD organization', () => {
		const html = `<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Organization","name":"SPSI","url":"https://www.europages.fr/fr/company/spsi-22277465","address":{"@type":"PostalAddress","streetAddress":"38 Rue De Lamirault","postalCode":"77090","addressLocality":"Collégien","addressCountry":"FR"},"description":"Concepteur français."}]}</script>`
		const d = parseEuropagesDetails(html, 'https://www.europages.fr/fr/company/spsi-22277465')
		expect(d.name).toBe('SPSI')
		expect(d.city).toBe('Collégien')
		expect(d.postalCode).toBe('77090')
		expect(d.description).toBe('Concepteur français.')
	})
})

describe('europages adapter', () => {
	it('paginates through mocked fetch', async () => {
		const html = `<html><head>${LD_JSON}</head><body><div data-test="search-results" total="7035" totalpages="235"></div></body></html>`
		const seen: string[] = []
		const fetchFn = (async (url: string | URL | Request) => {
			seen.push(String(url))
			return new Response(html, { status: 200 })
		}) as typeof fetch
		const adapter = createEuropagesAdapter(fetchFn)
		expect(adapter.name).toBe('europages')
		const paginator = await adapter.search('boulangerie')
		const entries = await paginator.page(1)
		expect(entries).toHaveLength(2)
		expect(paginator.maxPages).toBe(235)
		expect(seen[0]).toBe('https://www.europages.fr/entreprises/boulangerie.html')
		await expect(paginator.page(236)).rejects.toThrow(RangeError)
		await expect(paginator.page(0)).rejects.toThrow(RangeError)
	})

	it('fetches details by company url', async () => {
		const html = `<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Organization","name":"SPSI","url":"https://www.europages.fr/fr/company/spsi-22277465","address":{"@type":"PostalAddress","addressLocality":"Collégien","addressCountry":"FR"}}]}</script>`
		const seen: string[] = []
		const fetchFn = (async (url: string | URL | Request) => {
			seen.push(String(url))
			return new Response(html, { status: 200 })
		}) as typeof fetch
		const adapter = createEuropagesAdapter(fetchFn)
		const d = await adapter.details!('https://www.europages.fr/fr/company/spsi-22277465')
		expect(d.name).toBe('SPSI')
		expect(seen[0]).toBe('https://www.europages.fr/fr/company/spsi-22277465')
	})

	it('rejects empty search terms', async () => {
		const adapter = createEuropagesAdapter(async () => new Response('', { status: 200 }))
		await expect(adapter.search('  ')).rejects.toThrow()
	})

	it('throws on http error', async () => {
		const adapter = createEuropagesAdapter(async () => new Response('nope', { status: 403 }))
		await expect((await adapter.search('x')).page(1)).rejects.toThrow(/403/)
	})
})
