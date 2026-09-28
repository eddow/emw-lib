import type { ListEntry } from '../types.js'

const BASE = 'https://www.pagesjaunes.fr'

/**
 * Parse a PagesJaunes `chercherlespros` HTML page into list entries.
 *
 * Each professional is an `li.bi[id="bi-<numClient>"]` card with an
 * `a.bi-denomination[href="/pros/<id>"]` title anchor, `.bi-address`,
 * `.note_moyenne` rating + `.bi-rating` review count, opening status
 * (`Ouvre à …` / `Fermé …`), and an `Afficher le N°` button (phone numbers
 * require interaction — not available server-side).
 *
 * NOTE: plain `fetch`/curl gets a bot-wall page (Cloudflare); the adapter
 * works with browser-fetched HTML. `fetchHtml` surfaces non-OK statuses.
 */
export function parsePagesjaunesSearchPage(html: string): ListEntry[] {
	const cards = splitCards(html)
	const entries: ListEntry[] = []
	for (const card of cards) {
		const entry = parseCard(card)
		if (entry) entries.push(entry)
	}
	return entries
}

/**
 * Extract the total page count from a PagesJaunes search page.
 * Primary source: `#SEL-compteur` (`Page 1 / 59`); fallback: highest
 * `page=N` link. `NaN` when unknown.
 */
export function parsePagesjaunesMaxPages(html: string): number {
	const text = stripTags(html)
	const compteur = text.match(/Page\s*\d+\s*\/\s*(\d+)/)
	if (compteur) {
		const n = parseInt(compteur[1], 10)
		if (Number.isFinite(n) && n > 0) return n
	}
	let max = 0
	for (const m of html.matchAll(/[?&]page=(\d+)/g)) {
		const n = parseInt(m[1], 10)
		if (Number.isFinite(n) && n > max) max = n
	}
	if (max > 0) return max
	return NaN
}

function splitCards(html: string): string[] {
	const out: string[] = []
	// Anchor on the denomination link (one per result); the `li.bi` wrapper
	// also matches nested non-result items, so slice between anchors instead.
	const re = /<a[^>]*class="[^"]*bi-denomination[^"]*"[^>]*href="\/pros\/[a-z0-9]+"[^>]*>/g
	const starts: number[] = []
	let m: RegExpExecArray | null
	while ((m = re.exec(html)) !== null) starts.push(m.index)
	for (let i = 0; i < starts.length; i++) {
		const end = i + 1 < starts.length ? starts[i + 1] : html.length
		out.push(html.slice(starts[i], end))
	}
	return out
}

function parseCard(card: string): ListEntry | null {
	const anchor = card.match(
		/<a[^>]*class="[^"]*bi-denomination[^"]*"[^>]*href="(\/pros\/([a-z0-9]+))"[^>]*>([\s\S]*?)<\/a>/
	)
	if (!anchor) return null
	const title = stripTags(anchor[3]).replace(/\s+/g, ' ').trim()
	if (!title) return null

	const entry: ListEntry = { title, id: anchor[2], url: `${BASE}${anchor[1]}` }

	const address = card.match(/class="[^"]*bi-address[^"]*"[^>]*>([\s\S]*?)<\/div>/)
	if (address) {
		const text = stripTags(address[1])
			.replace(/\s+/g, ' ')
			.trim()
			.replace(/\s*Voir le plan\s*$/, '')
		if (text) entry.address = decodeEntities(text)
	}

	const rating = card.match(/class="note_moyenne"[^>]*>([^<]+)</)
	if (rating) {
		const v = parseFloat(rating[1].replace(',', '.'))
		if (Number.isFinite(v)) entry.rating = v
	}
	const reviews = card.match(/\((\d+)\s+avis\)/)
	if (reviews) entry.reviews = parseInt(reviews[1], 10)

	const hours = card.match(/((?:Ouvre|Ouvert|Fermé)[^<]{0,40})</)
	if (hours) entry.hours = decodeEntities(hours[1].trim())

	const img = card.match(/<img[^>]*src="([^"]+)"[^>]*>/)
	if (img && !img[1].startsWith('data:')) entry.thumbnail = decodeEntities(img[1])

	return entry
}

/** Parse a PagesJaunes `/pros/<id>` page into a `details()` record. */
export function parsePagesjaunesDetails(html: string, url: string): Record<string, unknown> {
	const details: Record<string, unknown> = { url }
	const id = url.match(/\/pros\/([a-z0-9]+)/)?.[1]
	if (id) details.id = id
	const name = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)
	if (name) {
		const t = stripTags(name[1]).replace(/\s+/g, ' ').trim()
		if (t) details.name = decodeEntities(t)
	}
	const address = html.match(
		/class="[^"]*(?:bi-address|address)[^"]*"[^>]*>([\s\S]{0,600}?)<\/(?:div|address|p)>/
	)
	if (address) {
		const t = stripTags(address[1]).replace(/\s+/g, ' ').trim()
		if (t) details.address = decodeEntities(t)
	}
	const phone = html.match(/(\d{2}(?:\s\d{2}){4})/)
	if (phone) details.phone = phone[1]
	const hours = html.match(/((?:Ouvre|Ouvert|Fermé)[^<]{0,60})</)
	if (hours) details.hours = decodeEntities(hours[1].trim())
	const rating = html.match(/class="note_moyenne"[^>]*>([^<]+)</)
	if (rating) {
		const v = parseFloat(rating[1].replace(',', '.'))
		if (Number.isFinite(v)) details.rating = v
	}
	const website = html.match(
		/<a[^>]*href="(https?:\/\/[^"]+)"[^>]*>(?:Site web|site[^<]{0,20})<\/a>/i
	)
	if (website) details.website = website[1]
	return details
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
