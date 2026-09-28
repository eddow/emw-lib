import type { ListEntry } from '../types.js'

const BASE = 'https://www.europages.fr'

/**
 * Parse an Europages company-search HTML page into list entries.
 *
 * Primary source (JSON-first): the `application/ld+json` `ItemList` named
 * after the query — 30 `Organization` items with `name`, `url`,
 * `address{addressLocality, addressCountry}`, `areaServed`,
 * `numberOfEmployees{value}`. HTML card tiles (`div[data-test="company"]`)
 * only supplement: logo thumbnail, supplier types, description.
 */
export function parseEuropagesSearchPage(html: string): ListEntry[] {
	const orgs = jsonLdItemList(html)
	if (orgs.length > 0) {
		const extras = htmlExtras(html)
		return orgs
			.map((org, i) => toListEntry(org, extras.get(orgId(org)) ?? extras.get(`pos-${i + 1}`)))
			.filter((e): e is ListEntry => e !== null)
	}
	const tiles = splitTiles(html)
	const entries: ListEntry[] = []
	for (const tile of tiles) {
		const entry = parseTile(tile)
		if (entry) entries.push(entry)
	}
	return entries
}

/**
 * Extract the total page count from an Europages search page.
 * Primary source: `div[data-test="search-results"][totalpages]`;
 * fallback: highest `/pg-N/` pager link. `NaN` when unknown.
 */
export function parseEuropagesMaxPages(html: string): number {
	const m = html.match(/data-test="search-results"[^>]*totalpages="(\d+)"/)
	if (m) {
		const n = parseInt(m[1], 10)
		if (Number.isFinite(n) && n > 0) return n
	}
	let max = 0
	for (const p of html.matchAll(/\/pg-(\d+)\//g)) {
		const n = parseInt(p[1], 10)
		if (Number.isFinite(n) && n > max) max = n
	}
	if (max > 0) return max
	return NaN
}

function splitTiles(html: string): string[] {
	const out: string[] = []
	const re = /<div[^>]*data-test="company"[^>]*data-scroll-restoration="company-tile-(\d+)"[^>]*>/g
	const starts: Array<{ index: number; id: string }> = []
	let m: RegExpExecArray | null
	while ((m = re.exec(html)) !== null) starts.push({ index: m.index, id: m[1] })
	for (let i = 0; i < starts.length; i++) {
		const end = i + 1 < starts.length ? starts[i + 1].index : html.length
		out.push(html.slice(starts[i].index, end))
	}
	return out
}

export function parseTile(tile: string): ListEntry | null {
	const id = tile.match(/data-scroll-restoration="company-tile-(\d+)"/)?.[1]
	const nameAnchor = tile.match(/<a[^>]*data-test="company-name"[^>]*>([\s\S]*?)<\/a>/)
	const href = tile.match(/<a[^>]*href="([^"]+)"[^>]*data-test="company-name"/)?.[1]
	if (!id || !nameAnchor || !href) return null
	const title = stripTags(nameAnchor[1]).replace(/\s+/g, ' ').trim()
	if (!title) return null

	const entry: ListEntry = { title, id, url: absolutize(href) }

	const logo = tile.match(/data-test="company-logo"[\s\S]{0,2000}?<img[^>]*src="([^"]+)"/)
	if (logo) entry.thumbnail = decodeEntities(logo[1])

	const country = tile.match(/<span>([^<]+)<\/span>,\s*<span class="city">([^<]+)<\/span>/)
	if (country) {
		entry.country = decodeEntities(country[1].trim())
		entry.city = decodeEntities(country[2].trim())
	}

	const employees = tile.match(/data-test="employee-count"[\s\S]{0,500}?<div>([^<]+)<\/div>/)
	if (employees) entry.workforce = decodeEntities(employees[1].trim())

	const delivery = tile.match(/Livraison:\s*([^<]+)</)
	if (delivery) entry.deliveryArea = decodeEntities(delivery[1].trim())

	// Simpler: collect known supplier-type labels present in the tile.
	const known = [
		...tile.matchAll(
			/(Fabricant\/Producteur|Fabricant|Grossiste|Prestataire de services|Détaillant|Agent\/Représentant|Importateur|Exportateur)/g
		),
	].map((s) => s[1])
	if (known.length > 0) entry.supplierTypes = [...new Set(known)]

	const description = tile.match(/data-test="description"[^>]*>([\s\S]*?)<\/div>/)
	if (description) {
		const text = stripTags(description[1]).replace(/\s+/g, ' ').trim()
		if (text) entry.description = decodeEntities(text)
	}

	return entry
}

/** Parse an Europages company page (HTML) into a `details()` record. */
export function parseEuropagesDetails(html: string, url: string): Record<string, unknown> {
	const ld = jsonLdOrganization(html)
	const details: Record<string, unknown> = { url }
	const name =
		(typeof ld.name === 'string' ? ld.name : null) ??
		html.match(/data-test="company-display-title"[^>]*>([\s\S]*?)</)?.[1]?.trim()
	if (name) details.name = decodeEntities(stripTags(name))
	const address = ld.address as Record<string, string> | undefined
	if (address) {
		details.address = [
			address.streetAddress,
			address.postalCode,
			address.locality ?? address.addressLocality,
			address.country ?? address.addressCountry,
		]
			.filter(Boolean)
			.join(' ')
		details.postalCode = address.postalCode ?? null
		details.city = address.locality ?? address.addressLocality ?? null
		details.country = address.country ?? address.addressCountry ?? null
	}
	if (ld.description) details.description = ld.description
	if (ld.telephone) details.phone = ld.telephone
	const facts = (key: string) =>
		html.match(new RegExp(`data-test="${key}"[\\s\\S]{0,800}?<div>([^<]+)<\\/div>`))?.[1].trim()
	const workforce = facts('employee-count')
	if (workforce) details.workforce = decodeEntities(workforce)
	return details
}

function jsonLdOrganization(html: string): Record<string, unknown> {
	const m = html.match(/<script type="application\/ld\+json">(.*?)<\/script>/s)
	if (!m) return {}
	try {
		const data = JSON.parse(m[1]) as {
			'@graph'?: Array<Record<string, unknown>>
		}
		const org = data['@graph']?.find((n) => {
			const t = n['@type']
			return t === 'Organization' || (Array.isArray(t) && t.includes('Organization'))
		})
		return org ?? {}
	} catch {
		return {}
	}
}

function stripTags(html: string): string {
	return html.replace(/<[^>]*>/g, ' ')
}

function absolutize(href: string): string {
	if (/^https?:\/\//i.test(href)) return href
	return BASE.replace(/\/$/, '') + (href.startsWith('/') ? href : `/${href}`)
}

interface LdOrg {
	name?: string
	url?: string
	address?: { addressLocality?: string; addressCountry?: string }
	areaServed?: string
	numberOfEmployees?: { value?: string }
}

/** Numeric company id from an LD `url` (`...-22277465`) or `@id`. */
function orgId(org: LdOrg & { '@id'?: string }): string {
	const m = `${org.url ?? ''} ${org['@id'] ?? ''}`.match(/(\d{5,})/)
	return m ? m[1] : ''
}

function toListEntry(
	org: LdOrg & { '@id'?: string },
	extra?: { thumbnail?: string; supplierTypes?: string[]; description?: string }
): ListEntry | null {
	const id = orgId(org)
	if (!org.name || !org.url || !id) return null
	const entry: ListEntry = { title: org.name, id, url: org.url }
	if (org.address?.addressCountry) entry.country = org.address.addressCountry
	if (org.address?.addressLocality) entry.city = org.address.addressLocality
	if (org.areaServed) entry.deliveryArea = org.areaServed
	if (org.numberOfEmployees?.value) entry.workforce = org.numberOfEmployees.value
	if (extra?.thumbnail) entry.thumbnail = extra.thumbnail
	if (extra?.supplierTypes) entry.supplierTypes = extra.supplierTypes
	if (extra?.description) entry.description = extra.description
	return entry
}

/** The `ItemList` (named after the query) inside the search-page JSON-LD graph. */
function jsonLdItemList(html: string): Array<LdOrg & { '@id'?: string }> {
	const m = html.match(/<script type="application\/ld\+json">(.*?)<\/script>/s)
	if (!m) return []
	try {
		const data = JSON.parse(m[1]) as {
			'@graph'?: Array<Record<string, unknown>>
		}
		for (const node of data['@graph'] ?? []) {
			if (node['@type'] !== 'ItemList' || !Array.isArray(node['itemListElement'])) continue
			const orgs: Array<LdOrg & { '@id'?: string }> = []
			for (const li of node['itemListElement'] as Array<{
				item?: LdOrg & { '@id'?: string }
			}>) {
				if (li.item && typeof li.item.name === 'string') orgs.push(li.item)
			}
			// The breadcrumb ItemList also matches; the company list has Organization items.
			if (orgs.length > 0 && (orgs[0] as Record<string, unknown>)['@type'] === 'Organization')
				return orgs
		}
		return []
	} catch {
		return []
	}
}

/** Per-company HTML extras keyed by numeric id (logo, supplier types, description). */
function htmlExtras(
	html: string
): Map<string, { thumbnail?: string; supplierTypes?: string[]; description?: string }> {
	const map = new Map<
		string,
		{ thumbnail?: string; supplierTypes?: string[]; description?: string }
	>()
	for (const tile of splitTiles(html)) {
		const id = tile.match(/data-scroll-restoration="company-tile-(\d+)"/)?.[1]
		if (!id) continue
		const extra: { thumbnail?: string; supplierTypes?: string[]; description?: string } = {}
		const logo = tile.match(/data-test="company-logo"[\s\S]{0,2000}?<img[^>]*src="([^"]+)"/)
		if (logo) extra.thumbnail = decodeEntities(logo[1])
		const known = [
			...tile.matchAll(
				/(Fabricant\/Producteur|Fabricant|Grossiste|Prestataire de services|Détaillant|Agent\/Représentant|Importateur|Exportateur)/g
			),
		].map((s) => s[1])
		if (known.length > 0) extra.supplierTypes = [...new Set(known)]
		const description = tile.match(/data-test="description"[^>]*>([\s\S]*?)<\/div>/)
		if (description) {
			const text = stripTags(description[1]).replace(/\s+/g, ' ').trim()
			if (text) extra.description = decodeEntities(text)
		}
		map.set(id, extra)
	}
	return map
}

function decodeEntities(s: string): string {
	return s
		.replace(/&amp;/g, '&')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
}
