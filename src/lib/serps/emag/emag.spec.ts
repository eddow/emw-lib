import { describe, expect, it } from 'vitest'
import { createEmagAdapter, emag, emagSearchUrl } from './index.js'
import { parseEmagMaxPages, parseEmagSearchPage } from './parse.js'

const CARD = `
<div class="card-item card-standard js-product-data js-card-clickable "
  data-product-id="29167659" data-offer-id="83834603"
  data-category-name="Telefoane Mobile"
  data-category-trail="Laptop, Tablete &amp; Telefoane/Telefoane Mobile"
  data-name="Telefon mobil Nokia 106, Dual SIM, Negru" data-position="1"
  data-url="https://www.emag.ro/telefon-mobil-nokia-106-dual-sim-negru-dvrtk5bbm/pd/DTHYVBMBM/">
  <div class="card-v2">
    <a href="https://www.emag.ro/x/pd/DTHYVBMBM/" class="card-v2-thumb">
      <img src="https://example.com/img.jpg?width=720" alt="Telefon mobil Nokia 106, Dual SIM, Negru" />
    </a>
    <h2><a class="card-v2-title">Telefon mobil Nokia 106, Dual SIM, Negru</a></h2>
    <div class="card-v2-rating"><span class="average-rating fw-semibold">3.44</span>
      <span class="hidden-xs ">86 de review-uri</span></div>
    <div class="mb-1 fw-semibold fs-12 text-availability-in_stock">în stoc</div>
    <div class="card-v2-pricing">
      <p class="pricing rrp-lp30d"><s>69<sup><small class="mf-decimal">&#44;</small>03</sup> <span>Lei</span></s></p>
      <p class="product-new-price">60<sup><small class="mf-decimal">&#44;</small>50</sup> <span>Lei</span></p>
    </div>
  </div>
</div>`

describe('emagSearchUrl', () => {
	it('builds first-page and paged urls', () => {
		expect(emagSearchUrl('telefon')).toBe('https://www.emag.ro/search/telefon')
		expect(emagSearchUrl('telefon mobil', 2)).toBe('https://www.emag.ro/search/telefon+mobil/p2')
	})

	it('builds locale urls', () => {
		expect(emagSearchUrl('telefon', 1, 'bg')).toBe('https://www.emag.bg/search/telefon')
		expect(emagSearchUrl('telefon', 2, 'hu')).toBe('https://www.emag.hu/search/telefon/p2')
	})
})

describe('parseEmagSearchPage', () => {
	it('parses a product card', () => {
		const entries = parseEmagSearchPage(`<div id="card_grid">${CARD}${CARD}</div>`)
		expect(entries).toHaveLength(2)
		const [e] = entries
		expect(e.title).toBe('Telefon mobil Nokia 106, Dual SIM, Negru')
		expect(e.id).toBe('29167659')
		expect(e.url).toBe(
			'https://www.emag.ro/telefon-mobil-nokia-106-dual-sim-negru-dvrtk5bbm/pd/DTHYVBMBM/'
		)
		expect(e.price).toBe(60.5)
		expect(e.currency).toBe('Lei')
		expect(e.oldPrice).toBe(69.03)
		expect(e.rating).toBe(3.44)
		expect(e.reviews).toBe(86)
		expect(e.thumbnail).toBe('https://example.com/img.jpg?width=720')
		expect(e.availability).toBe('în stoc')
		expect(e.offerId).toBe('83834603')
	})

	it('skips cards missing id/title/url', () => {
		expect(parseEmagSearchPage('<div>no cards here</div>')).toEqual([])
	})
})

describe('parseEmagMaxPages', () => {
	it('reads "1 din 49" paginator', () => {
		expect(parseEmagMaxPages('<span>1 din 49</span>')).toBe(49)
	})

	it('falls back to data-page links', () => {
		expect(parseEmagMaxPages('<a data-page="1">1</a><a data-page="3">3</a>')).toBe(3)
	})

	it('returns NaN when unknown', () => {
		expect(parseEmagMaxPages('<div>no pagination</div>')).toBeNaN()
	})
})

describe('emag adapter', () => {
	it('exposes ro/bg/hu adapters', async () => {
		expect(emag.ro.name).toBe('emag.ro')
		expect(emag.bg.name).toBe('emag.bg')
		expect(emag.hu.name).toBe('emag.hu')
	})

	it('paginates through mocked fetch', async () => {
		const html = `<div id="card_grid">${CARD}</div><span>1 din 2</span>`
		const seen: string[] = []
		const fakeFetch = async (url: string | URL | Request) => {
			seen.push(String(url))
			return new Response(html, { status: 200 })
		}
		const adapter = createEmagAdapter(fakeFetch as typeof fetch)
		expect(adapter.name).toBe('emag.ro')
		const paginator = await adapter.search('telefon')
		const entries = await paginator.page(1)
		expect(entries).toHaveLength(1)
		expect(paginator.maxPages).toBe(2)
		expect(seen[0]).toBe('https://www.emag.ro/search/telefon')
		await expect(paginator.page(3)).rejects.toThrow(RangeError)
		await expect(paginator.page(0)).rejects.toThrow(RangeError)
	})

	it('uses the bg base url when locale is bg', async () => {
		const seen: string[] = []
		const fakeFetch = async (url: string | URL | Request) => {
			seen.push(String(url))
			return new Response('<div></div>', { status: 200 })
		}
		const adapter = createEmagAdapter(fakeFetch as typeof fetch, 'bg')
		expect(adapter.name).toBe('emag.bg')
		const paginator = await adapter.search('telefon')
		await paginator.page(1)
		expect(seen[0]).toBe('https://www.emag.bg/search/telefon')
	})

	it('rejects empty search terms', async () => {
		const adapter = createEmagAdapter(async () => new Response('', { status: 200 }))
		await expect(adapter.search('  ')).rejects.toThrow()
	})

	it('throws on http error', async () => {
		const adapter = createEmagAdapter(async () => new Response('nope', { status: 403 }))
		const paginator = await adapter.search('telefon')
		await expect(paginator.page(1)).rejects.toThrow(/403/)
	})
})
