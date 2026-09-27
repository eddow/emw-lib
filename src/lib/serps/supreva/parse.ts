import type { ListEntry } from '../types.js'

/** Raw product item as returned by the Supreva `react_product_list` JSON block. */
export interface SuprevaRawItem {
	id: number
	code: string
	name: string
	link: string
	url: string
	main_img: string
	vendor_brand: string
	vendor_link: string
	buyer_price: { min_price: string; max_price: string; symbol: string } | null
	currency_code: string
	vendor_currency_symbol: string
	min_vendor_price: number
	max_vendor_price: number
	min_qty: number
	stock: number
	rating: number
	reviews: number
	vat: number
	[key: string]: unknown
}

export interface SuprevaPage {
	total: number
	limit: number
	page: number
	items: SuprevaRawItem[]
}

/**
 * Extract the `productsItems` block from a Supreva `?init_page=1` JSON response.
 * Returns `null` when the shape is not recognised.
 */
export function parseSuprevaResponse(json: unknown): SuprevaPage | null {
	if (typeof json !== 'object' || json === null) return null
	const grids = (json as { data?: { grids?: Array<{ blockType?: string; blockInfo?: unknown }> } })
		.data?.grids
	if (!Array.isArray(grids)) return null
	const block = grids.find((g) => g.blockType === 'react_product_list')?.blockInfo as
		| {
				productsItems?: {
					total?: unknown
					limit?: unknown
					page?: unknown
					items?: unknown
				}
		  }
		| undefined
	const pi = block?.productsItems
	if (!pi || !Array.isArray(pi.items)) return null
	const total = Number(pi.total)
	const limit = Number(pi.limit)
	const page = Number(pi.page)
	if (!Number.isFinite(total) || !Number.isFinite(limit) || limit <= 0) return null
	return {
		total,
		limit,
		page: Number.isFinite(page) ? page : 1,
		items: pi.items as SuprevaRawItem[],
	}
}

/** Total page count for a Supreva result set (NaN when unknown). */
export function suprevaMaxPages(total: number, limit: number): number {
	if (!Number.isFinite(total) || !Number.isFinite(limit) || limit <= 0) return NaN
	return Math.max(1, Math.ceil(total / limit))
}

/** Map one raw Supreva item to a `ListEntry`. */
export function toListEntry(item: SuprevaRawItem, base = 'https://supreva.com'): ListEntry {
	const url = absolutize(item.url || item.link || '', base)
	const entry: ListEntry = {
		title: item.name,
		id: item.code || String(item.id),
		url,
	}
	if (item.main_img) entry.thumbnail = item.main_img
	if (item.vendor_brand) entry.vendor = item.vendor_brand
	if (item.vendor_link) entry.vendorUrl = absolutize(item.vendor_link, base)
	if (Number.isFinite(item.min_qty)) entry.minQty = item.min_qty
	if (Number.isFinite(item.stock)) entry.stock = item.stock
	if (Number.isFinite(item.rating)) entry.rating = item.rating
	if (Number.isFinite(item.reviews)) entry.reviews = item.reviews
	if (Number.isFinite(item.vat)) entry.vat = item.vat
	if (item.currency_code) entry.currency = item.currency_code

	const price = suprevaPrice(item)
	if (price !== null) {
		entry.price = price.value
		entry.priceCurrency = price.currency
	}
	if (Number.isFinite(item.min_vendor_price)) entry.priceRon = item.min_vendor_price
	return entry
}

function suprevaPrice(item: SuprevaRawItem): { value: number; currency: string } | null {
	const bp = item.buyer_price
	if (bp && bp.min_price) {
		const v = parseFloat(bp.min_price)
		if (Number.isFinite(v)) return { value: v, currency: bp.symbol || '€' }
	}
	return null
}

function absolutize(href: string, base: string): string {
	if (/^https?:\/\//i.test(href)) return href
	return base.replace(/\/$/, '') + (href.startsWith('/') ? href : `/${href}`)
}
