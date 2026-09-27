/** Shared contracts for search-engine / marketplace scrapers (SERP adapters). */

export interface ListEntry {
	title: string;
	/** Source-specific stable id (e.g. eMAG `data-product-id` or part number). */
	id: string;
	url: string;
	/** Any extra fields exposed by the source (price, rating, thumbnail, ...). */
	[key: string]: unknown;
}

export interface Paginator {
	/** Total page count, or `NaN` when the source doesn't expose it. */
	maxPages: number;
	page(n: number): Promise<ListEntry[]>;
}

export interface ScraperAdapter {
	/** Source name, e.g. `emag`. Matches `src/lib/serps/<name>/`. */
	name: string;
	search(terms: string): Promise<Paginator>;
	details?(id: string): Promise<Record<string, unknown>>;
}

export type FetchFn = typeof fetch;
