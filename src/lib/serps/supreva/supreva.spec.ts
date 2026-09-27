import { describe, expect, it } from 'vitest'
import { createSuprevaAdapter, suprevaSearchUrl } from './index.js'
import { parseSuprevaResponse, suprevaMaxPages, toListEntry } from './parse.js'

function response(total: number, limit: number, page: number, items: unknown[]) {
	return {
		data: {
			grids: [
				{ blockType: 'react_header', blockInfo: {} },
				{
					blockType: 'react_product_list',
					blockInfo: {
						productsItems: {
							total,
							limit,
							page,
							baseUrl: 'https://supreva.com/en/search/x/',
							items,
						},
					},
				},
			],
		},
	}
}

const ITEM = {
	id: 861557,
	code: 'Q2A5P1-b09vxbsnzy',
	name: 'Lampa birou LED cu clema',
	link: '/en/lampa-birou-led/pd/IGS5',
	url: 'https://supreva.com/en/lampa-birou-led/pd/IGS5',
	main_img: 'https://supreva.com/images/thumbnails/150/img.jpg',
	vendor_brand: 'Zergo',
	vendor_link: '/en/zergo-airini-srl-en/s2518/',
	buyer_price: { min_price: '10.48', max_price: '10.48', symbol: '€' },
	currency_code: 'RON',
	vendor_currency_symbol: 'lei',
	min_vendor_price: 54.99,
	max_vendor_price: 54.99,
	min_qty: 1,
	stock: 13,
	rating: 0,
	reviews: 0,
	vat: 21,
}

describe('suprevaSearchUrl', () => {
	it('builds first-page and paged urls', () => {
		expect(suprevaSearchUrl('birou')).toBe('https://supreva.com/en/search/birou/?init_page=1')
		expect(suprevaSearchUrl('Scaun Birou', 2)).toBe(
			'https://supreva.com/en/search/scaun+birou/pg-2/?init_page=1'
		)
	})
})

describe('parseSuprevaResponse', () => {
	it('extracts the productsItems block', () => {
		const parsed = parseSuprevaResponse(response(51, 40, 1, [ITEM]))
		expect(parsed).not.toBeNull()
		expect(parsed!.total).toBe(51)
		expect(parsed!.limit).toBe(40)
		expect(parsed!.page).toBe(1)
		expect(parsed!.items).toHaveLength(1)
	})

	it('returns null on unexpected shapes', () => {
		expect(parseSuprevaResponse(null)).toBeNull()
		expect(parseSuprevaResponse({})).toBeNull()
		expect(parseSuprevaResponse({ data: { grids: [] } })).toBeNull()
	})
})

describe('suprevaMaxPages', () => {
	it('ceil-divides total by limit', () => {
		expect(suprevaMaxPages(51, 40)).toBe(2)
		expect(suprevaMaxPages(21, 40)).toBe(1)
		expect(suprevaMaxPages(80, 40)).toBe(2)
	})

	it('returns NaN when unknown', () => {
		expect(suprevaMaxPages(NaN, 40)).toBeNaN()
		expect(suprevaMaxPages(10, 0)).toBeNaN()
	})
})

describe('toListEntry', () => {
	it('maps a raw item', () => {
		const e = toListEntry(ITEM as never)
		expect(e.title).toBe('Lampa birou LED cu clema')
		expect(e.id).toBe('Q2A5P1-b09vxbsnzy')
		expect(e.url).toBe('https://supreva.com/en/lampa-birou-led/pd/IGS5')
		expect(e.price).toBe(10.48)
		expect(e.priceCurrency).toBe('€')
		expect(e.priceRon).toBe(54.99)
		expect(e.currency).toBe('RON')
		expect(e.vendor).toBe('Zergo')
		expect(e.thumbnail).toBe('https://supreva.com/images/thumbnails/150/img.jpg')
		expect(e.minQty).toBe(1)
	})
})

describe('supreva adapter', () => {
	it('paginates through mocked fetch', async () => {
		const seen: string[] = []
		const fakeFetch = async (url: string | URL | Request) => {
			seen.push(String(url))
			return new Response(JSON.stringify(response(51, 40, 1, [ITEM])), {
				status: 200,
				headers: { 'content-type': 'application/json' },
			})
		}
		const adapter = createSuprevaAdapter(fakeFetch as typeof fetch)
		expect(adapter.name).toBe('supreva')
		const paginator = await adapter.search('lampa')
		const entries = await paginator.page(1)
		expect(entries).toHaveLength(1)
		expect(entries[0].title).toBe('Lampa birou LED cu clema')
		expect(paginator.maxPages).toBe(2)
		expect(seen[0]).toBe('https://supreva.com/en/search/lampa/?init_page=1')
		await expect(paginator.page(3)).rejects.toThrow(RangeError)
		await expect(paginator.page(0)).rejects.toThrow(RangeError)
	})

	it('rejects empty search terms', async () => {
		const adapter = createSuprevaAdapter(async () => new Response('{}', { status: 200 }))
		await expect(adapter.search('  ')).rejects.toThrow()
	})

	it('throws on http error and on unexpected shape', async () => {
		const bad = createSuprevaAdapter(async () => new Response('nope', { status: 503 }))
		await expect((await bad.search('x')).page(1)).rejects.toThrow(/503/)
		const shapeless = createSuprevaAdapter(async () => new Response('{}', { status: 200 }))
		await expect((await shapeless.search('x')).page(1)).rejects.toThrow(/unexpected response/)
	})
})
