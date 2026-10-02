# Sentry (`src/lib/sentry/`)

Shared Sentry config so every app wires it in ~10 lines. The lib owns
option builders, scrub rules and env mapping; hosts own DSN/env wiring,
`hooks.*` + `vite.config` one-liners and `+error.svelte` reporting.

## Layout

- `index.ts` (client-safe `./sentry`): `readSentryEnv()` (`SENTRY_*`
  naming — same pattern as `readAuthEnv`), `shouldInitSentry()` (empty
  DSN / vitest-playwright / **localhost dev** all no-op),
  `buildSentryOptions()` (`sendDefaultPii: false`, replays off,
  `beforeSend` → `scrubEvent`), `scrubEvent()` (single enforcement
  point: cookies/auth headers, `salt` query, body secrets, 500-char
  prompt/tool previews), `reportError()` / `sentryBreadcrumb()` /
  `setSentryUser()` (console-only no-ops when Sentry is off — call
  unconditionally from lib code).
- `server.ts` (types) + `engine.js` (runtime) via `./sentry-server`:
  `initSentryServer()` / `initSentryClient()` (host passes its
  `Sentry.init` — the lib never imports `@sentry/sveltekit`),
  `sentryHandle()` / `handleErrorWithSentry()` (declarative
  `hooks.server.ts` / `hooks.client.ts`), `withSentryRoute()`,
  `viteSentryPlugin()` (org/project only; token from env at build).
- `pure.js`: self-contained plain-JS copy of the pure helpers for
  raw-Node `vite.config.ts` (same rule as `db/engine.js` — Node ≥22.6
  refuses type-stripping under `node_modules`). Keep in sync with
  `index.ts` by hand.
- `index.test.ts` / `server.test.ts`: options defaults, `scrubEvent`
  denylist, `shouldInitSentry` (incl. localhost), init no-ops, plugin
  forwarding.

## Host wiring (arb2b/emw reference)

1. `vite.config.ts`: `viteSentryPlugin({ org, project, sentrySvelteKit })`
   (import `sentrySvelteKit` from `@sentry/sveltekit/vite`).
2. `hooks.client.ts`: `readSentryEnv()` from `PUBLIC_*` vars →
   `initSentryClient({ init, env }, { hostname, url })` + `handleError`.
3. `instrumentation.server.ts` (arb2b) / server hooks (both):
   `readSentryEnv(env)` → `initSentryServer({ init, env })`;
   `hooks.server.ts` wraps `sentryHandle()` first + `handleError`.
4. `+error.svelte`: `reportError(page.error)` on mount for 5xx only
   (404s stay silent — Sentry's `handleError` already drops 4xx).
5. `+server.ts` routes (`/contact`, `/fmdm/pdf`): `reportError(err,
   { route })` next to `console.error` on 500 paths.
6. `.env.example`: `SENTRY_DSN`, `PUBLIC_SENTRY_DSN`,
   `SENTRY_ENVIRONMENT`, `SENTRY_RELEASE`, `SENTRY_TRACES_SAMPLE_RATE`,
   build-only `SENTRY_AUTH_TOKEN`/`SENTRY_ORG`/`SENTRY_PROJECT`.

Localhost dev never reports: empty DSN, `MODE=test`, `VITEST` /
`PLAYWRIGHT_TEST`, or `localhost`/`127.0.0.1`/`::1` hostname all no-op.
