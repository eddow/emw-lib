---
name: emw-lib
description: Shared TypeScript library for emedware frontends (Alfred client, SERP adapters, BODACC scraper). Use when creating, editing, or testing anything under emw-lib/src/lib, or when wiring emw to Alfred via emw-lib.
---

# emw-lib

Client-safe shared library (`emw-lib/src/lib`). No `node:` imports, no
`$lib/server`, no env reads — the host app injects config (`FetchFn`,
`baseUrl`, credentials).

## Layout

- `src/lib/alfred/` — Alfred client. Full guide: `docs/alfred.md`. Protocol: `butler/docs/alfred.md`.
- `src/lib/serps/` — search adapters, `FetchFn`-injected.
- `src/lib/scrappers/bodacc/` — BODACC scraper client.
- `docs/` — `README.md` (conventions + commands), `alfred.md` (client guide).

## Alfred quick reference

```svelte
<AlfredChat credential={{ generation_id, stream_token, stream_url }} onsend={send} />
```

- `StreamCredential = { generation_id, stream_token, stream_url }` — from the
  BE's prompt/play response, forwarded over the app's priv channel; the
  browser never hardcodes a host and never mints.
- Stream-only FE: `GenerationStream.attach(credential)` + `onsend(prompt) =>
  Promise<StreamCredential | null>` (browser → APP action → per-policy APP
  call → new credential back). The APP owns control; the FE opens only the
  stream. `ButlerSession` is a deprecated alias of `GenerationStream`.
- Core is framework-free (`types` → `client` → `stream` → `transcript`);
  only `session.svelte.ts` (runes) and `Chat.svelte` are Svelte-aware.
- Deltas are ephemeral (never persisted, never messages); reconnect cursor is
  durable `seq` only (generation-local, from 1; `stream_id` IS the
  `generation_id`).

## Checks (from `emw-lib/`)

```bash
pnpm exec vitest run --project server src/lib/alfred
pnpm exec vitest run --project client src/lib/alfred
pnpm exec svelte-check --tsconfig ./tsconfig.json
pnpm exec biome check src/lib/alfred
```

All four must be green. Test placement matters: `*.svelte.test.ts` runs in
the `client` (browser) project where runes work; plain `*.test.ts` runs in
`server` (node).
