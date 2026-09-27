import { describe, expect, it } from 'vitest'
import { aosomSearchUrl, createAosomAdapter } from './index.js'
import { parseAosomMaxPages, parseAosomSearchPage } from './parse.js'

const ANCHOR = `
<a href="/item/vinsetto-scaun-de-birou~21UDKD31I2G01.html?spm=product_list" class="js-grid-item-a"
  value="21UDKD31I2G01" sellersku="921-187" price="76999" index="1"
  name="Vinsetto Scaun de birou pivotant" urlkey="vinsetto-scaun-de-birou">
  <div class="js-grid-item-content">
    <div class="js-goods-img">
      <img class="js-white-img" src="https://img.aosomcdn.com/thumbnail/100/img.jpg.webp"
        data-img-url="https://img.aosomcdn.com/img.jpg" alt="Vinsetto Scaun de birou pivotant" />
    </div>
    <h2 class="js-name">Vinsetto Scaun de birou pivotant</h2>
    <div class="js-price"><span class="js-set-price present-price">769<span class="text-16">,99 Lei</span></span></div>
    <div class="js-flash-badge"><span class="ant-tag-default">-6/12% | Cod: ANIV6</span></div>
    <div class="js-star"><div><span class="text-14 color-text ml-1">5</span></div></div>
  </div>
</a>`

describe('aosomSearchUrl', () => {
	it('builds first-page and paged urls', () => {
		expect(aosomSearchUrl('birou')).toBe('https://www.aosom.ro/k/birou.html')
		expect(aosomSearchUrl('Scaun Birou', 2)).toBe('https://www.aosom.ro/k/scaun+birou.html?page=2')
	})
})

describe('parseAosomSearchPage', () => {
	it('parses a product anchor', () => {
		const entries = parseAosomSearchPage(`<div class="card">${ANCHOR}${ANCHOR}</div>`)
		expect(entries).toHaveLength(2)
		const [e] = entries
		expect(e.title).toBe('Vinsetto Scaun de birou pivotant')
		expect(e.id).toBe('921-187')
		expect(e.url).toBe('https://www.aosom.ro/item/vinsetto-scaun-de-birou~21UDKD31I2G01.html')
		expect(e.price).toBe(769.99)
		expect(e.currency).toBe('Lei')
		expect(e.rating).toBe(5)
		expect(e.thumbnail).toBe('https://img.aosomcdn.com/thumbnail/100/img.jpg.webp')
		expect(e.badge).toBe('-6/12% | Cod: ANIV6')
		expect(e.sku).toBe('921-187')
	})

	it('falls back to anchor price cents when no price span', () => {
		const noPrice = ANCHOR.replace(/<div class="js-price">[\s\S]*?<\/div>/, '')
		const [e] = parseAosomSearchPage(noPrice)
		expect(e.price).toBe(769.99)
	})

	it('skips anchors missing id/href/title', () => {
		expect(parseAosomSearchPage('<div>no products</div>')).toEqual([])
	})
})

describe('parseAosomMaxPages', () => {
	it('reads savePMes pages attribute', () => {
		expect(
			parseAosomMaxPages('<div class="savePMes" pages="40" pagesize="30" total="1195" pagenum="1">')
		).toBe(40)
	})

	it('falls back to ant-pagination item numbers', () => {
		expect(parseAosomMaxPages('<li class="ant-pagination-item-40"><a>40</a></li>')).toBe(40)
	})

	it('returns NaN when unknown', () => {
		expect(parseAosomMaxPages('<div>no pagination</div>')).toBeNaN()
	})
})

describe('aosom adapter', () => {
	it('paginates through mocked fetch', async () => {
		const html = `<div class="card">${ANCHOR}</div><div class="savePMes" pages="40" pagesize="30" total="1195" pagenum="1">`
		const seen: string[] = []
		const fakeFetch = async (url: string | URL | Request) => {
			seen.push(String(url))
			return new Response(html, { status: 200 })
		}
		const adapter = createAosomAdapter(fakeFetch as typeof fetch)
		expect(adapter.name).toBe('aosom')
		const paginator = await adapter.search('birou')
		const entries = await paginator.page(1)
		expect(entries).toHaveLength(1)
		expect(paginator.maxPages).toBe(40)
		expect(seen[0]).toBe('https://www.aosom.ro/k/birou.html')
		await expect(paginator.page(41)).rejects.toThrow(RangeError)
		await expect(paginator.page(0)).rejects.toThrow(RangeError)
	})

	it('rejects empty search terms', async () => {
		const adapter = createAosomAdapter(async () => new Response('', { status: 200 }))
		await expect(adapter.search('  ')).rejects.toThrow()
	})

	it('throws on http error', async () => {
		const adapter = createAosomAdapter(async () => new Response('nope', { status: 403 }))
		const paginator = await adapter.search('birou')
		await expect(paginator.page(1)).rejects.toThrow(/403/)
	})
})
