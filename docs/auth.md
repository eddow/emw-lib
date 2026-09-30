# Auth (`src/lib/auth/`)

User management for the emedware frontends. Each app owns its own DB, so
roles live directly on the user row: `{ user: roles }` — no cross-app
membership table. The host app registers its domain by simply using the
lib (its DB *is* the domain).

## Layout

- `types.ts` (client-safe `./auth`): `AuthUser`/`AuthSession`/`AuthState`,
  `Role`, `hasRole()`/`requireRole()`, `listSocialProviders()` /
  `credentialFlows()` (allowlist → login UI), `resolvePreference()`
  (explicit > DB row > browser default), `toLocale()`/`toTheme()`.
- `server.ts` (server-only `./auth-server`): `readAuthEnv(raw)`
  (raw `AUTH_*` record → `AuthEnv` — the one place that knows the env
  naming), `createAuth(env, db)` (better-auth + `admin` plugin +
  `role`/`locale`/`theme` `additionalFields`, `basePath: '/auth'`,
  `trustedOrigins` from `AUTH_TRUSTED_ORIGINS`), `populateLocals(auth, event)`,
  `resolveSession()`, `parseRoles()`/`serializeRoles()`,
  `enabledProviderIds()`, `effectiveAllowlist(env)` — the single source
  of truth for what the login UI offers: a provider appears iff its
  `AUTH_<ID>_{ID,SECRET}` pair is present, intersected with
  `AUTH_ENABLED_PROVIDERS` when set (unset = auto: `email` + every
  configured social provider).
- `LoginScreen.svelte` (+ `AuthClient` facade): shadcn-shaped card
  (self-contained styles reading the host's `--card`/`--primary`/…
  palette with neutral fallbacks), email/password sign-in,
  registration, lost-password (request + `?token=` confirm), "Log in
  with…" social buttons. The host passes a facade over
  `better-auth/svelte` — the component never imports better-auth
  directly, so the client is swappable.

## Host wiring (arb2b reference)

1. `migrations/0000-initialisation.sql`: better-auth core tables
   (`user`, `session`, `account`, `verification`) + extras
   (`user.role` comma list, `user.locale`/`user.theme`, admin `banned`
   set). Applied by the `emw-lib/db-server` engine (runner +
   `vite build` plugin — see `docs/new-project.md` §6).
2. `src/lib/server/auth.ts`: `createAuth(readAuthEnv(env), { database: pool })`
   (`pg.Pool` on `DATABASE_URL`; `readAuthEnv` centralizes the whole
   `AUTH_*` mapping — hosts never map vars by hand).
3. `src/lib/auth-client.ts`: `createAuthClient({ baseURL, basePath: '/auth' })` +
   `adminClient()`.
4. `src/routes/login/+page.svelte` + `+page.server.ts`: server `load`
   returns `effectiveAllowlist(readAuthEnv(env))` (same mapping as the
   backend — only the id list reaches the browser);
   `<LoginScreen client={facade} allowlist={data.allowlist} />`.
5. `src/routes/auth/[...all]/+server.ts`: `auth.handler(request)`.
   Accept-header routing (no `/api/` prefix): SvelteKit serves HTML for
   `Accept: text/html` page loads and JSON for `fetch` calls on the same
   path, so a dedicated `/api/` namespace is unnecessary. Server
   `basePath: '/auth'` and client `basePath: '/auth'` must agree.
6. `src/hooks.server.ts`: `sequence(handleAuth, handleParaglide)` where
   `handleAuth` = `populateLocals(auth, event)` + `svelteKitHandler(...)`.
7. `src/app.d.ts`: `Locals { user, session, roles, locale, theme }`.
8. `.env.example`: `DATABASE_URL`, `AUTH_SECRET`, `PUBLIC_BASE_URL`,
   `AUTH_ENABLED_PROVIDERS` (optional — unset = auto-detect from
   present `AUTH_*` secrets), `AUTH_TRUSTED_ORIGINS` (comma-separated
   extra origins — set to the prod URL on Vercel, otherwise POSTs
   fail with 403 `INVALID_ORIGIN`), `AUTH_<PROVIDER>_{ID,SECRET}`,
   `RESEND_API_KEY`. No `PUBLIC_*` mirror needed: the login `load`
   computes the UI list server-side.

## Conventions

- The lib never imports `$app/*`, `$lib/server`, `node:`, or env — the
  host injects the pool, env, `sveltekitCookies` plugin (via
  `AuthEnv.sveltekitCookiesPlugin` when server actions set cookies) and
  the `svelteKitHandler` call. Same rule as the Alfred client.
- better-auth is a dependency of BOTH `emw-lib` (config shape) and the
  host (it imports `better-auth/svelte-kit` + `better-auth/svelte`
  directly — pnpm does not hoist the lib's copy to the host).
- `role` column is a comma-separated list (`admin,editor,viewer`);
  `parseRoles`/`serializeRoles` are the single place that split/join it.
- Preference layer: cookie > DB row (`user.locale`/`user.theme`) >
  browser default — `resolvePreference(explicit, stored, fallback)`.

## Checks (from `emw-lib/`)

```bash
pnpm exec vitest run --project server src/lib/auth
pnpm exec vitest run --project client src/lib/auth
pnpm exec svelte-check --tsconfig ./tsconfig.json
pnpm exec biome check src/lib/auth
```
