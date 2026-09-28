# Local tools — `emw-lib` (`src/lib/`)

Goal: Alfred gets a default toolset plus opt-in `lib-tools`.
Caller selects with `string[]`, e.g. `libTools: ['fetch_webpage', 'web_search', 'jev_decide', ...]`.
Registry maps name → `AgentTool` factory (`src/lib/alfred/tools.ts`: `AgentTool`, `toToolset`, `createToolHandler`).

Convention: `snake_case` names (cf. `emw/src/lib/server/agent/tools.ts`: `search_contacts`, `get_contact_context`, ...).
All network I/O via injectable `FetchFn`; secrets server-only (`emw` resolves from `$env/dynamic/private`).

## 1. Generic web — DEFAULT ON, to build — NOW IMPLEMENTED (`src/lib/tools/fetch.ts`, `websearch.ts`)

| name            | description                                                           | params                              | notes                                                                                       |
| --------------- | --------------------------------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------- |
| `fetch_webpage` | GET URL → `{ status, url, title?, text }` (HTML→text, cap ~20k chars) | `url: string`, `max_chars?: number` | UA header like `serps/*/index.ts`; non-2xx → `Error(status + url)`                          |
| `web_search`    | Keyword web search → `ListEntry[]` (`serps/types.ts`)                 | `q: string`, `limit?: number`       | Needs provider: Brave/Google CSE/DuckDuckGo — no key-free Google; decide + `SEARCH_API_KEY` — DECIDED: Brave API when key set, else DuckDuckGo |

## 2. `jev` — opt-in (`src/lib/tools/jev.ts`; transport rewritten to Decisions API)

Requires `apiKey` (`env.OPENROUTER_API_KEY`), `model` default `typesafe/jev-1.13`.

| name         | wraps                | params                                                                                                  |
| ------------ | -------------------- | ------------------------------------------------------------------------------------------------------- |
| `jev_decide` | `JevClient.decide()` | `{ state, questions: { id: { type: noul\|choice, instructions, criteria? } }, model? }` → `{ answers }` |
| `jev_match` | `is_same_product` noul | `{ a_title, b_title }` → `{ score, match }` (threshold 0.8) |
Jev is NOT a chat LLM — Decisions API (`POST /api/alpha/decisions`), model `typesafe/jev-1.13`. |

## 3. `serps` — opt-in, two parametric tools (`src/lib/tools/serps.ts`) 

| name                                                                | adapter                                                                            | search                                                             | details                            |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ---------------------------------- |
| `serp_search` / `serp_details` dispatch by `source` (annuaire, aosom, emag.ro/bg/hu, europages, kompass, pagesjaunes, supreva) — see `src/lib/tools/serps.ts` |
| `serp_aosom_search` — REMOVED, covered by `serp_search(source='aosom')` |
details only for annuaire-entreprises/europages/kompass/pagesjaunes |
| `serp_europages_search` / `serp_europages_details`                  | `europages` (`/entreprises/<q>.html`, `/pg-N/`, JSON-LD+HTML)                      | `q`                                                                | URL or numeric id                  |
| `serp_kompass_search` / `serp_kompass_details`                      | `kompass` (`/searchCompanies?searchType=PRODUCT`, DataDome-walled)                 | `q`                                                                | URL or id                          |
| `serp_pagesjaunes_search` / `serp_pagesjaunes_details`              | `pagesjaunes` (`quoiqui=<what>&ou=<where>&page=N`)                                 | `what, where` (parse `"<what> <where>"` like current `parseTerms`) | `/pros/<id>` or URL                |
| `serp_supreva_search`                                               | `supreva` (`/en/search/<q>/?init_page=1`, JSON)                                    | `q`                                                                | —                                  |

Uniform wrapper shape (`src/lib/tools/serps.ts`): `serp_search{source, terms}` → `{ entries: ListEntry[], maxPages }` (first `page(1)`); `serp_details{source, id}` → `Record<string, unknown>`.

## 4. `scrappers/bodacc` — opt-in, exists (`src/lib/scrappers/bodacc/client.ts`)

| name             | wraps                                                                                                                                   | params (`BodaccQueryOptions`)                                                                                                                               |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bodacc_leads`   | `fetchBodaccLeads()` → `BodaccRecord[]`                                                                                                 | `category` (`creation`, `modification`, `vente`, `collective`, `radiation`, `dpc`, ...), `department` (`69`, `2A`), `dateFrom`, `limit` (dflt 20), `offset` |
| `bodacc_parse` (`src/lib/tools/bodacc.ts`) | `{ record }` → `{ siren, name, persons, establishments, judgment, act, deposit }` |

Source: `BODACC_API_URL` (`bodacc-datadila.opendatasoft.com`, keyless). Flat records, JSON-encoded sub-fields — see `scrappers/bodacc/types.ts`.

## 5. Reference — `emw` domain tools (NOT lib, stay in `emw/src/lib/server/agent/tools.ts`)

`search_contacts`, `get_contact_context`, `get_entity`, `get_entity_threads`, `get_thread_emails`. Read-only v1; scope from `resolveScope` (`chatId`, `entityId`), never wire.

## Integration

```ts
// emw-lib: registry
createLibTool(name: string, deps: LibToolDeps): AgentTool
LIB_TOOL_DEFAULTS = ['fetch_webpage', 'web_search']
// emw/src/lib/server/agent/sessions.ts: CreateSessionOptions += libTools?: string[]
// resolve → AgentTool[] → existing toToolset(tools, webhookUrl, { max_iterations: 5 }, 15_000)