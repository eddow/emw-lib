import type { ListEntry } from '../types.js'

const BASE = 'https://fr.kompass.com'

/**
 * Parse a Kompass `searchCompanies` HTML page (company tab) into list entries.
 *
 * Companies are `div.blockNameCompany` blocks with an
 * `a.titleSpan[href="/c/<slug>/<code>/"]` anchor (`name` attr = Kompass code),
 * `span.placeText` location, and `span.tagOrange` role tags
 * (Producteur/Distributeur/Exportateur/...).
 *
 * NOTE: plain `fetch`/curl gets a DataDome captcha wall; the adapter works
 * with browser-fetched HTML. `fetchHtml` surfaces non-OK statuses.
 */
export function parseKompassSearchPage(html: string): ListEntry[] {
	const blocks = splitBlocks(html)
	const entries: ListEntry[] = []
	for (const block of blocks) {
		const entry = parseBlock(block)
		if (entry) entries.push(entry)
	}
	return entries
}

/**
 * Extract the total page count from a Kompass search page.
 * Source: highest `tab=cmp&pageNbre=N` pager link. `NaN` when unknown.
 */
export function parseKompassMaxPages(html: string): number {
	let max = 0
	for (const m of html.matchAll(/tab=cmp&pageNbre=(\d+)/g)) {
		const n = parseInt(m[1], 10)
		if (Number.isFinite(n) && n > max) max = n
	}
	if (max > 0) return max
	return NaN
}

function splitBlocks(html: string): string[] {
	const out: string[] = []
	const re = /<div[^>]*class="[^"]*blockNameCompany[^"]*"[^>]*>/g
	const starts: number[] = []
	let m: RegExpExecArray | null
	while ((m = re.exec(html)) !== null) starts.push(m.index)
	for (let i = 0; i < starts.length; i++) {
		const end = i + 1 < starts.length ? starts[i + 1] : html.length
		out.push(html.slice(starts[i], end))
	}
	return out
}

function parseBlock(block: string): ListEntry | null {
	const anchor = block.match(
		/<a[^>]*class="[^"]*titleSpan[^"]*"[^>]*href="(\/c\/[a-z0-9-]+\/[a-z0-9]+\/?)"[^>]*>([\s\S]*?)<\/a>/
	)
	if (!anchor) return null
	const title = stripTags(anchor[2]).replace(/\s+/g, ' ').trim()
	if (!title) return null
	const code = anchor[1].match(/\/c\/[a-z0-9-]+\/([a-z0-9]+)\/?/)?.[1] ?? anchor[1]

	const entry: ListEntry = { title, id: code, url: `${BASE}${anchor[1]}` }

	const place = block.match(/class="placeText"[^>]*>([^<]+)</)
	if (place) {
		const loc = decodeEntities(place[1].trim())
		const parts = loc.split(/\s*-\s*/)
		if (parts.length > 1) {
			entry.city = parts[0].trim()
			entry.country = parts.slice(1).join(' - ').trim()
		} else {
			entry.city = loc
		}
	}

	const roles = [...block.matchAll(/class="tag tagOrange"[^>]*>\s*([^<]+?)\s*</g)]
		.map((r) => decodeEntities(r[1].trim()))
		.filter(Boolean)
	if (roles.length > 0) entry.roles = [...new Set(roles)]

	if (/tagCertif/.test(block)) entry.certified = true

	return entry
}

/** Parse a Kompass `/c/<slug>/<code>/` company page into a `details()` record. */
export function parseKompassDetails(html: string, url: string): Record<string, unknown> {
	const ld = jsonLdOrganization(html)
	const details: Record<string, unknown> = { url }
	const id = url.match(/\/c\/[a-z0-9-]+\/([a-z0-9]+)\/?/)?.[1]
	if (id) details.id = id
	if (ld.name) details.name = ld.name
	const address = ld.address as Record<string, string> | undefined
	if (address) {
		details.address = [
			address.streetAddress,
			address.postalCode,
			address.addressLocality,
			address.addressCountry,
		]
			.filter(Boolean)
			.join(' ')
		details.postalCode = address.postalCode ?? null
		details.city = address.addressLocality ?? null
		details.country = address.addressCountry ?? null
	}
	if (ld.description) details.description = ld.description
	if (ld.telephone) details.phone = ld.telephone
	if (!ld.telephone) {
		const tel = html.match(/tel:([0-9.\- ]+)/)
		if (tel) details.phone = tel[1].trim()
	}
	const geo = ld.geo as Record<string, string> | undefined
	if (geo?.latitude) details.latitude = geo.latitude
	if (geo?.longitude) details.longitude = geo.longitude
	return details
}

function jsonLdOrganization(html: string): Record<string, unknown> {
	for (const m of html.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/gs)) {
		try {
			const data = JSON.parse(m[1]) as Record<string, unknown>
			const graphs = Array.isArray(data['@graph'])
				? (data['@graph'] as Array<Record<string, unknown>>)
				: [data]
			for (const node of graphs) {
				const t = node['@type']
				if (t === 'Organization' || (Array.isArray(t) && t.includes('Organization'))) return node
				if (t === 'LocalBusiness' || (Array.isArray(t) && t.includes('LocalBusiness'))) return node
			}
		} catch {}
	}
	return {}
}

function stripTags(html: string): string {
	return html.replace(/<[^>]*>/g, ' ')
}

function decodeEntities(s: string): string {
	return s
		.replace(/&amp;/g, '&')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
}
