# How to create a SERP adapter

This guide explains how an agent adds a new search-engine / marketplace
scraper under `src/lib/serps/<name>/`. It is distilled from the three
existing adapters: `emag` (HTML cards + locale namespace), `aosom`
(HTML anchors + attributes), `supreva` (JSON payload).

## 1. Contracts (read first)

`src/lib/serps/types.ts` defines the whole public surface:

```ts
interface ListEntry {
  title: string;
  id: string;   // stable, source-specific (SKU, product id, code, ...)
  url: string;  // absolute URL of the item page
  [key: string]: unknown; // extras: price, currency, rating, thumbnail, ...
}
interface Paginator {
  maxPages: number; // total pages, or NaN when the source hides it
  page(n: number): Promise<ListEntry[]>;
}
interface ScraperAdapter {
  name: string; // e.g. 'supreva', or 'emag.ro' for locale namespaces
  search(terms: string, opts?: SearchOpts): Promise<Paginator>;
  details?(id: string): Promise<Record<string, unknown>>;
}
```

Rules:

- `ListEntry` MUST always contain `title`, `id`, `url`. Everything else is
  source-dependent but prefer the shared vocabulary when it exists:
  `price` (number), `currency` / `priceCurrency`, `oldPrice`, `rating`,
  `reviews`, `thumbnail`, `availability`, `vendor`, `stock`, `minQty`.
- `maxPages` is resolved lazily: it stays `NaN` until the first `page()`
  call fetches HTML/JSON and extracts the total. Callers read it *after*
  the first `page()` call.
- `page(n)` MUST throw `RangeError` for `n < 1` (non-integer too) and for
  `n > maxPages` once `maxPages` is known.
- `search('')` (blank terms) MUST throw.
- HTTP failures MUST throw `Error` containing status + URL.
- Parsing lives in `parse.ts` (pure functions, no fetch). Fetching +
  pagination lives in `index.ts`. Never mix them.
- One folder per source: `src/lib/serps/<name>/{index.ts,parse.ts,<name>.spec.ts}`.

## 2. Search signature and custom parameters

The current signature is `search(terms: string)`. Sources often support
extra filters (eMAG categories, price ranges, sort orders, per-page limits,
Supreva `limitItems` / `sortItems`). Design for that from the start:

```ts
interface SearchOpts {
  /** Free-form, source-specific filters. Keep the base signature working. */
  [key: string]: unknown;
}
search(terms: string, opts?: SearchOpts): Promise<Paginator>
```

Guidelines:

- `search(terms)` with no opts MUST keep working (sensible defaults).
- Put opts plumbing in the URL builder (`xxxSearchUrl(terms, page, opts?)`)
  so it is unit-testable without fetch.
- Store opts on the paginator and apply them to every `page(n)` fetch.
- Document each supported opt in the adapter's JSDoc (name, type, example).
- If a source has locales with different base URLs but shared markup
  (eMAG ro/bg/hu), export a namespace object instead of a single adapter:

```ts
export const emag: Record<EmagLocale, ScraperAdapter> = { ro, bg, hu };
```

## 3. Reconnaissance (browser first, curl second)

Do NOT guess URL patterns. Open the site in the integrated browser:

1. `open_browser_page` on the homepage (use the English locale path if the
   site offers one, e.g. `supreva.com/en`).
2. Type a query into the search box (`type_in_page` with `submit: true`)
   and record the resulting URL. That is your canonical search URL.
3. `run_playwright_code` with `page.evaluate(...)` to inspect:
   - product card markup / attributes (title link, id, price, image),
   - the total-results text (`"Afiseaza 1-30 din 1296 rezultate"`,
     `"21 products"`, ...),
   - the pagination widget (page links, `data-page` attrs, `?page=N`,
     `/pg-N/`, `/pN` ...).
4. Click page 2 in the browser and record how the URL changes. That gives
   you the page-parameter pattern. Verify it with a second fetch.
5. Check `performance.getEntriesByType('resource')` for XHR/JSON endpoints:
   some sites (Supreva) serve a JSON payload when asked
   (`?init_page=1` + `accept: application/json`) — prefer JSON over HTML
   whenever it exists.
6. Only then try `curl` with a desktop UA. Some sites (Aosom) return 403
   to curl/Akamai but work in the browser — note that in the adapter docs
   and make sure errors surface the HTTP status.

Save raw samples under the repo `tmp/` folder (git-ignored), never `/tmp`.

## 4. URL builder

Export `xxxSearchUrl(terms, page = 1, ...)`:

- Page 1 is usually the bare URL; later pages add the page token.
  Observed patterns: eMAG `/search/<q>/p2`, Aosom `/k/<q>.html?page=2`,
  Supreva `/en/search/<q>/pg-2/?init_page=1`.
- Normalise terms the way the site does (lowercase? `+` for spaces?).
  `encodeURIComponent(terms.trim()).replace(/%20/g, '+')` is the common case.
- Keep it pure and exported — the spec tests it without network.

## 5. Parser (`parse.ts`)

Pure functions only. **Prefer JSON over HTML, always.** Search-result pages
very often embed the data as JSON, in one of two places — check both before
writing a single HTML regex:

1. **Embedded in the page**: `<script type="application/json">` blocks,
   `EM.listingGlobals.items = [...]` style assignments, `data-*` JSON
   attributes on the cards (eMAG `button.add-to-favorites[data-product]`
   carries exact `price`/`currency`/`pnk`), JSON-LD
   (`script[type="application/ld+json"]`, used by arb2b's `emag.py` for
   detail pages: description, specs, brand). Extract with a bracket-matching
   slice + `JSON.parse`, never with fragile `.*` regexes.
2. **Behind a fetch/XHR endpoint**: watch `performance.getEntriesByType
   ('resource')` in the browser. Supreva serves the whole result set as JSON
   (`?init_page=1` + `accept: application/json`); eMAG exposes
   `EM.sapi_endpoint = "https://sapi.emag.ro"`. A JSON endpoint beats page
   HTML every time — no markup churn, no locale price parsing.

Only fall back to HTML for fields the JSON genuinely lacks (eMAG's
`listingGlobals.items` has no price/url/rating — those still come from the
card HTML / `data-product` payload; the strikethrough old price exists only
in `<s>` markup).

Two recommended shapes:

**JSON-first sources** — export `parseXxxResponse(json)` returning
`{ total, limit, page, items } | null`, plus `toListEntry(raw)`:

- Return `null` (don't throw) on unrecognised shapes; the paginator turns
  that into `Error('... unexpected response shape (url)')`.
- `suprevaMaxPages(total, limit) = ceil(total / limit)`, `NaN` on bad input.

**HTML fallback** — export `parseXxxSearchPage(html, base?)` and
`parseXxxMaxPages(html)`:

- Split the HTML into per-product chunks first (match card anchors, then
  slice between matches), then parse each chunk. This survives nested
  markup better than one giant regex.
- Prefer data attributes over visible text: eMAG `data-product-id`,
  `data-name`, `data-url`; Aosom `name`, `sellersku`, `price` (cents),
  `href` on `a.js-grid-item-a`.
- Prices: strip tags first, then parse locale formats (`60,50 Lei`,
  `1.169,99 Lei` → strip thousand dots, comma → dot) — but ONLY when no
  JSON price exists. Fallback chain: JSON payload → visible price HTML
  (Aosom `price` attr = cents; eMAG old price in `<s>`).
- `maxPages` sources in priority order: explicit attribute
  (Aosom `.savePMes[pages]`, Supreva `total/limit`), human text
  (`1 din 49`), page-number links (`data-page`, `ant-pagination-item-N`).
  Return `NaN` when nothing is found.
- Skip cards missing `id`/`title`/`url` instead of throwing.
- Include a small `decodeEntities` helper (`&amp;`, `&quot;`, `&#44;` ...).

## 6. Adapter (`index.ts`)

Follow this template (copy `supreva/index.ts`, the simplest):

```ts
const BASE = 'https://...';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) ... Chrome/120 Safari/537.36';

export function xxxSearchUrl(terms: string, page = 1): string { ... }

async function fetchHtml(url, fetchFn) { // or fetchPageJson
  const res = await fetchFn(url, { headers: { 'user-agent': UA /* + accept: application/json */ } });
  if (!res.ok) throw new Error(`xxx search failed: ${res.status} ${res.statusText} (${url})`);
  return await res.text(); // or res.json()
}

class XxxPaginator implements Paginator {
  maxPages = NaN;
  private resolved = false;
  constructor(private terms: string, private fetchFn: FetchFn /*, private opts? */) {}
  async page(n: number): Promise<ListEntry[]> {
    if (!Number.isInteger(n) || n < 1) throw new RangeError(`xxx: page must be >= 1, got ${n}`);
    if (!Number.isNaN(this.maxPages) && n > this.maxPages)
      throw new RangeError(`xxx: page ${n} exceeds maxPages ${this.maxPages}`);
    const data = await fetch...(xxxSearchUrl(this.terms, n), this.fetchFn);
    if (!this.resolved) { this.maxPages = parseXxxMaxPages(data); this.resolved = true; }
    return parseXxxSearchPage(data);
  }
}

export function createXxxAdapter(fetchFn: FetchFn = fetch): ScraperAdapter {
  return { name: 'xxx', async search(terms, opts?) {
    if (!terms.trim()) throw new Error('xxx: search terms must not be empty');
    return new XxxPaginator(terms, fetchFn /*, opts */);
  } };
}
export const xxx: ScraperAdapter = createXxxAdapter();
```

Notes:

- `createXxxAdapter(fetchFn)` takes fetch as a parameter — this is what
  makes the adapter unit-testable with mocked `Response` objects.
- Always send a desktop `user-agent`. Add `accept: application/json` only
  for JSON endpoints.
- Error messages are prefixed with the adapter name (`xxx:` or `xxx.ro:`).

## 7. Tests (`<name>.spec.ts`)

Cover, at minimum (see `supreva.spec.ts` / `emag.spec.ts`):

1. URL builder: page 1 + page 2 (+ locale / opts variants).
2. Parser: one realistic card/item → all fields; skips incomplete cards;
   `maxPages` primary source, fallback source, `NaN` case.
3. Adapter with mocked fetch: `page(1)` returns entries, `maxPages` set,
   first fetched URL correct, `page(0)` / `page(>max)` reject with
   `RangeError`, blank `search('  ')` rejects, HTTP error status surfaces.

Use inline HTML/JSON fixtures (one representative card is enough), plus —
when the site allows it — validate once against a real saved page from
`tmp/` (e.g. eMAG: 60 entries, maxPages 49) via a scratch node script,
not as a committed test (no network in unit tests).

## 8. Wiring

1. Re-export from `src/lib/serps/index.ts`:
   `export { createXxxAdapter, xxx, xxxSearchUrl } from './xxx/index.js';`
   (plus any option/locale types). `src/lib/index.ts` already re-exports
   `./serps/index.js`, so nothing else is needed.
2. Run `npm run test:unit -- --run src/lib/serps/` (from `emw-lib/`) and
   `npm run check`. Both MUST be green: all spec files pass, `svelte-check`
   reports 0 errors.
3. Code style: tabs, no semicolons (biome), JSDoc on exported functions.
   Prefer the generic edit tools over shell hacks.

## 9. Checklist before declaring done

- [ ] `xxxSearchUrl` exported, tested, matches browser-observed URLs.
- [ ] `parse.ts` pure, tested, skips bad cards, `maxPages` → `NaN` fallback.
- [ ] `createXxxAdapter` + `xxx` exported, `search` validates terms.
- [ ] `Paginator.page` validates `n`, enforces `maxPages`, resolves it once.
- [ ] Spec covers URLs, parser, mocked-fetch pagination, error cases.
- [ ] Re-exported from `serps/index.ts`; `test:unit` + `check` green.
- [ ] `details(id)` only if the source has a useful detail page (plain data,
      no raw HTML); otherwise omit it.
