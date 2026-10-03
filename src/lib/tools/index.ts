/**
 * `src/lib/tools/` — intentionally empty.
 *
 * The lib tools that used to live here (`fetch_webpage`, `web_search`,
 * `jev_decide`, `jev_match`, `serp_search`, `serp_details`, `scrape`,
 * `bodacc_parse` + the `createLibTool`/`resolveLibTools` registry) are now
 * Alfred builtins: `butler/src/alfred/builtins/` executes them in-process
 * (`execution.type: 'builtin'`, see `butler/docs/tools.md` §§3–4).
 *
 * `emw` advertises builtins with descriptors from `emw-lib/alfred`
 * (`builtinToolset`, `BUILTIN_TOOL_NAMES`) — no `execute`, no keys, no
 * webhook round-trip. Scraping executes in Butler (`builtins/serps.py`);
 * no TS adapter remains in `emw-lib`.
 */
export {}
