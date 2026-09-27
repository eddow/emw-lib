import type { ListEntry } from '../types.js'

/**
 * Parse Aosom `/k/<terms>.html` search-result HTML into list entries.
 *
 * Each product is an `a.js-grid-item-a` anchor carrying rich attributes:
 * `name`, `sellersku` (stable SKU id), `value` (SIN), `price` (cents),
 * `href`, plus card body (`.js-name`, `.js-set-price`, `.js-star`, `img`).
 */
export function parseAosomSearchPage(html: string, base = 'https://www.aosom.ro'): ListEntry[] {
	const anchors = splitAnchors(html)
	const entries: ListEntry[] = []
	for (const a of anchors) {
		const entry = parseAnchor(a, base)
		if (entry) entries.push(entry)
	}
	return entries
}

/**
 * Extract the total page count from Aosom search HTML.
 * Primary source: `<div class="savePMes" pages="40" ...>`; fallback:
 * last `.ant-pagination-item-N` number. Returns `NaN` when unknown.
 */
export function parseAosomMaxPages(html: string): number {
	const save = html.match(/class="savePMes"[^>]*pages="(\d+)"/)
	if (save) {
		const n = parseInt(save[1], 10)
		if (Number.isFinite(n) && n > 0) return n
	}
	let max = 0
	for (const m of html.matchAll(/ant-pagination-item-(\d+)/g)) {
		const n = parseInt(m[1], 10)
		if (Number.isFinite(n) && n > max) max = n
	}
	if (max > 0) return max
	return NaN
}

function splitAnchors(html: string): string[] {
	const out: string[] = []
	const re = /<a[^>]*class="[^"]*js-grid-item-a[^"]*"[^>]*>/g
	const starts: number[] = []
	let m: RegExpExecArray | null
	while ((m = re.exec(html)) !== null) starts.push(m.index)
	for (let i = 0; i < starts.length; i++) {
		const end = html.indexOf('</a>', starts[i])
		if (end === -1) continue
		out.push(html.slice(starts[i], end + 4))
	}
	return out
}

function parseAnchor(a: string, base: string): ListEntry | null {
	const openTag = a.slice(0, a.indexOf('>') + 1)
	const href = attr(openTag, 'href')
	const nameAttr = decodeEntities(attr(openTag, 'name'))
	const sellersku = attr(openTag, 'sellersku')
	const sin = attr(openTag, 'value')
	const id = sellersku || sin
	if (!id || !href) return null

	const title =
		nameAttr ||
		textOf(a.match(/<h2[^>]*class="[^"]*js-name[^"]*"[^>]*>([\s\S]*?)<\/h2>/)?.[1] ?? '')
	if (!title) return null

	const url = absolutize(href.split('?')[0], base)
	const entry: ListEntry = { title, id, url }
	if (sin && sin !== id) entry.sin = sin
	if (sellersku) entry.sku = sellersku

	const price = parsePrice(a, openTag)
	if (price !== null) {
		entry.price = price
		entry.currency = 'Lei'
	}

	const rating = a.match(/class="[^"]*js-star[^"]*"[\s\S]{0,2000}?<span[^>]*>([\d.,]+)<\/span>/)
	if (rating) {
		const v = parseFloat(rating[1].replace(',', '.'))
		if (Number.isFinite(v)) entry.rating = v
	}

	const img =
		a.match(/<img[^>]*class="[^"]*js-white-img[^"]*"[^>]*src="([^"]+)"/) ??
		a.match(/<img[^>]*data-img-url="([^"]+)"/) ??
		a.match(/<img[^>]*src="([^"]+)"/)
	if (img) entry.thumbnail = decodeEntities(img[1])

	const badge = a.match(/class="[^"]*ant-tag-default[^"]*"[^>]*>([^<]+)</)
	if (badge) entry.badge = decodeEntities(badge[1].trim())

	return entry
}

function parsePrice(a: string, openTag: string): number | null {
	const m = a.match(/class="[^"]*js-set-price[^"]*"[^>]*>([\s\S]*?)<\/span>/)
	if (m) {
		const v = parseRoPrice(stripTags(m[1]))
		if (v !== null) return v
	}
	const cents = attr(openTag, 'price')
	if (/^\d+$/.test(cents)) {
		const v = parseInt(cents, 10) / 100
		if (Number.isFinite(v)) return v
	}
	return null
}

function parseRoPrice(s: string): number | null {
	const m = s.replace(/\s+/g, ' ').match(/([\d.]+),(\d{2})/)
	if (!m) return null
	const v = parseFloat(`${m[1].replace(/\./g, '')}.${m[2]}`)
	return Number.isFinite(v) ? v : null
}

function attr(tag: string, name: string): string {
	const m = tag.match(new RegExp(`${name}="([^"]*)"`))
	return m ? m[1] : ''
}

function textOf(html: string): string {
	return decodeEntities(stripTags(html).replace(/\s+/g, ' ').trim())
}

function stripTags(html: string): string {
	return html.replace(/<[^>]*>/g, '')
}

function absolutize(href: string, base: string): string {
	if (/^https?:\/\//i.test(href)) return href
	return base.replace(/\/$/, '') + (href.startsWith('/') ? href : `/${href}`)
}

function decodeEntities(s: string): string {
	return s
		.replace(/&amp;/g, '&')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
}
