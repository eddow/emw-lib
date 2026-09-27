# Search-engine / marketplace scrapers

## Objective

Provide one scraper adapter per source (e.g. amazon, emag, google, ...).
Each adapter exposes a uniform search API, hiding source-specific HTML / pagination details.

## API

### 1. `search(terms) -> Paginator`

```ts
interface Paginator {
  maxPages: number | NaN; // NaN when total is unknown
  page(n: number): Promise<ListEntry[]>;
}

interface ListEntry {
  title: string;
  id: string;
  url: string;
  // + any extra fields exposed by the source (price, rating, thumbnail, ...)
  [key: string]: unknown;
}

function search(terms: string): Promise<Paginator>;
```

### 2. `details(id) -> Detail` (optional)

Returns a parsed detail view for one entry, stripped of HTML noise.

```ts
function details(id: string): Promise<Record<string, unknown>>;
```

Only implemented when the source offers a useful detail page. Return plain data, no raw HTML.

## Conventions

- One folder/file per source under `src/lib/serps/<source>/`. SERP stands for SearchEngineResearchPage.
- `ListEntry` must always contain `title`, `id`, `url`. Extra fields are source-dependent.
- Parsing only: no browser automation side-effects, no caching at this stage.
