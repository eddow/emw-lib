# emw-lib

Shared TypeScript library for the emedware frontends (`emw`, demos, scripts).
Pure client-safe modules, injectable `fetch`, unit-tested. No `node:` imports,
no SvelteKit `$lib/server`, no env reads — the host app passes config in.

## Modules

| Path | What |
|---|---|
| `src/lib/alfred/` | Alfred client: transport + streaming + chat (see `docs/alfred.md`) |
| `src/lib/auth/` | Auth: client-safe roles/prefs (`./auth`), server better-auth wiring (`./auth-server`), `LoginScreen` (see `docs/auth.md`) |
| `src/lib/sentry/` | Sentry: client-safe options/scrub/env (`./sentry`), server init/handle/vite glue (`./sentry-server`, plain-JS `engine.js` + `pure.js` for raw-Node `vite.config.ts`; see `docs/sentry.md`) |
| `src/lib/db/` | DB: forward-only Neon migration runner + `vite build` plugin + manual CLI (server-only `./db-server`; hosts keep only `migrations/*.sql`) |
| `docs/new-project.md` | New-app scaffold checklist: emw-lib link trio, migrations on build, auth wiring, verify (agent entry point) |

## Conventions

- `FetchFn = typeof fetch` injection, defaulting to global `fetch`. Tests pass
  a mock; no live network in tests.
- Biome style: tabs, single quotes, `semicolons: asNeeded`, ~100 cols.
- Errors: one error class per module (e.g. `AlfredError extends Error` with
  `{ status, code, detail }`) — never raw `Response`.
- Vitest projects: `server` (node, `src/**/*.{test,spec}.{js,ts}`) and
  `client` (browser/playwright, `src/**/*.svelte.{test,spec}.{js,ts}`).
  Runes (`.svelte.ts`) and components (`.svelte`) only work in `client`.
- `svelte-check` must be 0 errors / 0 warnings; `biome check` clean.

## Commands (run from `emw-lib/`)

```bash
pnpm exec vitest run --project server src/lib/alfred   # node tests
pnpm exec vitest run --project client src/lib/alfred   # browser tests
pnpm exec svelte-check --tsconfig ./tsconfig.json      # types + svelte
pnpm exec biome check src/lib/alfred                   # lint + format
```
