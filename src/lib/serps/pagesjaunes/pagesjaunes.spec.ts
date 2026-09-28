import { describe, expect, it } from 'vitest'
import { createPagesjaunesAdapter, pagesjaunesSearchUrl, parseTerms } from './index.js'
import {
	parsePagesjaunesDetails,
	parsePagesjaunesMaxPages,
	parsePagesjaunesSearchPage,
} from './parse.js'

const CARD = `
<li id="bi-00287424" class="bi bi-generic bi-propay">
<div class="bi-with-visual"><div class="bi-content">
<div class="bi-header-title">
<a class="bi-denomination pj-link" href="/pros/00287424"><h3 class="truncate-2-lines">Max Poilâne</h3></a>
</div>
<div class="bi-align-items">
<a class="bi-rating-container"><span class="bi-note h4"><span class="note_moyenne">5</span></span><span class="bi-rating">(10 avis)</span></a>
</div>
<div class="bi-address small">87 rue Brancion 75015 Paris <a>Voir le plan</a></div>
<div class="bi-hours">Ouvre à 07h30</div>
<img src="/media/logo/thumb.jpg" alt="logo" />
</div></div>
</li>`

describe('pagesjaunesSearchUrl', () => {
	it('builds first-page and paged urls', () => {
		expect(pagesjaunesSearchUrl('boulangerie', 'Paris-75')).toBe(
			'https://www.pagesjaunes.fr/annuaire/chercherlespros?quoiqui=boulangerie&ou=Paris-75'
		)
		expect(pagesjaunesSearchUrl('boulangerie', 'Paris-75', 2)).toBe(
			'https://www.pagesjaunes.fr/annuaire/chercherlespros?quoiqui=boulangerie&ou=Paris-75&page=2'
		)
	})
})

describe('parseTerms', () => {
	it('splits activity and locality', () => {
		expect(parseTerms('boulangerie Paris-75')).toEqual({ what: 'boulangerie', where: 'Paris-75' })
		expect(parseTerms('boulangerie à Paris')).toEqual({ what: 'boulangerie', where: 'Paris' })
		expect(parseTerms('plombier, Lyon')).toEqual({ what: 'plombier', where: 'Lyon' })
		expect(parseTerms('boulangerie')).toEqual({ what: 'boulangerie', where: 'France' })
	})

	it('rejects blank terms', () => {
		expect(() => parseTerms('  ')).toThrow()
	})
})

describe('parsePagesjaunesSearchPage', () => {
	it('parses a professional card', () => {
		const entries = parsePagesjaunesSearchPage(`<ul>${CARD}${CARD}</ul>`)
		expect(entries).toHaveLength(2)
		const [e] = entries
		expect(e.title).toBe('Max Poilâne')
		expect(e.id).toBe('00287424')
		expect(e.url).toBe('https://www.pagesjaunes.fr/pros/00287424')
		expect(e.address).toBe('87 rue Brancion 75015 Paris')
		expect(e.rating).toBe(5)
		expect(e.reviews).toBe(10)
		expect(e.hours).toBe('Ouvre à 07h30')
		expect(e.thumbnail).toBe('/media/logo/thumb.jpg')
	})

	it('skips cards without denomination anchor', () => {
		expect(parsePagesjaunesSearchPage('<div>no pros</div>')).toEqual([])
	})
})

describe('parsePagesjaunesMaxPages', () => {
	it('reads the SEL-compteur', () => {
		expect(
			parsePagesjaunesMaxPages('<span id="SEL-compteur"><strong>Page 1</strong> / 59</span>')
		).toBe(59)
	})

	it('falls back to page= links', () => {
		expect(parsePagesjaunesMaxPages('<a href="?quoiqui=x&page=3">3</a>')).toBe(3)
	})

	it('returns NaN when unknown', () => {
		expect(parsePagesjaunesMaxPages('<div>no pager</div>')).toBeNaN()
	})
})

describe('parsePagesjaunesDetails', () => {
	it('reads name, address, phone', () => {
		const d = parsePagesjaunesDetails(
			'<h1>Max Poilâne</h1><div class="bi-address">87 rue Brancion 75015 Paris</div><span>01 48 28 45 90</span>',
			'https://www.pagesjaunes.fr/pros/00287424'
		)
		expect(d.name).toBe('Max Poilâne')
		expect(d.address).toBe('87 rue Brancion 75015 Paris')
		expect(d.phone).toBe('01 48 28 45 90')
		expect(d.id).toBe('00287424')
	})
})

describe('pagesjaunes adapter', () => {
	it('paginates through mocked fetch', async () => {
		const html = `<ul>${CARD}</ul><span id="SEL-compteur"><strong>Page 1</strong> / 59</span>`
		const seen: string[] = []
		const fetchFn = (async (url: string | URL | Request) => {
			seen.push(String(url))
			return new Response(html, { status: 200 })
		}) as typeof fetch
		const adapter = createPagesjaunesAdapter(fetchFn)
		expect(adapter.name).toBe('pagesjaunes')
		const paginator = await adapter.search('boulangerie Paris-75')
		const entries = await paginator.page(1)
		expect(entries).toHaveLength(1)
		expect(entries[0].title).toBe('Max Poilâne')
		expect(paginator.maxPages).toBe(59)
		expect(seen[0]).toBe(
			'https://www.pagesjaunes.fr/annuaire/chercherlespros?quoiqui=boulangerie&ou=Paris-75'
		)
		await expect(paginator.page(60)).rejects.toThrow(RangeError)
		await expect(paginator.page(0)).rejects.toThrow(RangeError)
	})

	it('fetches details by pros id', async () => {
		const seen: string[] = []
		const fetchFn = (async (url: string | URL | Request) => {
			seen.push(String(url))
			return new Response('<h1>Max Poilâne</h1>', { status: 200 })
		}) as typeof fetch
		const adapter = createPagesjaunesAdapter(fetchFn)
		const d = await adapter.details!('00287424')
		expect(d.name).toBe('Max Poilâne')
		expect(seen[0]).toBe('https://www.pagesjaunes.fr/pros/00287424')
	})

	it('rejects empty search terms', async () => {
		const adapter = createPagesjaunesAdapter(async () => new Response('', { status: 200 }))
		await expect(adapter.search('  ')).rejects.toThrow()
	})

	it('throws on http error', async () => {
		const adapter = createPagesjaunesAdapter(async () => new Response('nope', { status: 403 }))
		await expect((await adapter.search('boulangerie Paris')).page(1)).rejects.toThrow(/403/)
	})
})
