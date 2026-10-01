# New project configuration

Checklist + copy-paste to scaffold a new emedware SvelteKit app (`emw`, `arb2b`
are the references; `arb2b` is the minimal one). The goal: `emw-lib` wiring,
Neon migrations on build, better-auth, paraglide, tailwind, vitest, playwright,
biome — all green from day one.

## 0. Target layout

```
<app>/
  .env.example
  .npmrc
  AGENTS.md
  package.json
  pnpm-workspace.yaml
  pnpmfile.mjs
  tsconfig.json
  vercel.json
  vite.config.ts
  playwright.config.ts
  project.inlang/settings.json
  messages/{en,fr,ro}.json
  migrations/0000-initialisation.sql
  scripts/db-migrate.mjs
  src/
    app.d.ts
    app.html
    hooks.server.ts
    hooks.ts
    lib/server/{auth.ts,db.ts}
    lib/{auth-client.ts,index.ts}
    routes/login/{+page.server.ts,+page.svelte}
    routes/auth/[...all]/+server.ts
    routes/{+layout.svelte,layout.css,+page.server.ts,+page.svelte}
  static/robots.txt
```

No `svelte.config.*` — SvelteKit config lives inline in `vite.config.ts`
(`sveltekit({ adapter, ... })`). No per-app `biome.json` either — root
`biome.json` covers all apps.

## 1. `package.json`

Scripts (copy verbatim):

```json
{
	"scripts": {
		"dev": "vite dev",
		"build": "vite build",
		"preview": "vite preview",
		"prepare": "svelte-kit sync || echo ''",
		"check": "svelte-kit sync && svelte-check --tsconfig ./tsconfig.json",
		"check:watch": "svelte-kit sync && svelte-check --tsconfig ./tsconfig.json --watch",
		"db:migrate": "node scripts/db-migrate.mjs",
		"test:unit": "vitest run",
		"test": "pnpm run test:unit && pnpm run test:e2e",
		"test:e2e": "playwright install && playwright test",
		"biome:check": "biome check .",
		"biome:fix": "biome check --write .",
		"biome:format": "biome format --write ."
	}
}
```

Deps — app always needs (versions: copy from `arb2b/package.json` at scaffold time):

- `dependencies`: `@neondatabase/serverless`, `better-auth`, `pg`,
  `"emw-lib": "github:eddow/emw-lib"` (exact spec — see §2).
- `devDependencies`: `@sveltejs/kit`, `@sveltejs/adapter-vercel`, `svelte`,
  `vite`, `typescript`, `svelte-check`, `@sveltejs/vite-plugin-svelte`,
  `@tailwindcss/vite`, `tailwindcss`, `@inlang/paraglide-js`,
  `vitest`, `@vitest/browser-playwright`, `vitest-browser-svelte`,
  `@playwright/test`, `playwright`, `@biomejs/biome`, `@types/pg`.
- `"packageManager": "pnpm@11.25.0"`, `"type": "module"`, `"private": true`.

`better-auth` must be a direct dependency of BOTH `emw-lib` and the host
(the host imports `better-auth/svelte-kit` + `better-auth/svelte` directly —
pnpm does not hoist the lib's copy).

## 2. `emw-lib` github → workspace redirection (REQUIRED in every app)

Three files, copy verbatim (only the sibling comment mentions the app name).
`package.json` declares the published form so remote builds (Vercel, CI —
single repo cloned) work with zero config; local dev rewrites to the sibling
checkout when present.

`pnpm-workspace.yaml`:

```yaml
packages:
  - '.'
  - '../emw-lib'
linkWorkspacePackages: true
preferWorkspacePackages: true
pnpmfile: ./pnpmfile.mjs
allowBuilds:
  esbuild: true
```

`pnpmfile.mjs`:

```js
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const hasLocalLib = existsSync(join(here, '..', 'emw-lib', 'package.json'))

export const hooks = {
	readPackage(pkg) {
		if (hasLocalLib && pkg.dependencies?.['emw-lib'] === 'github:eddow/emw-lib') {
			pkg.dependencies['emw-lib'] = 'workspace:../emw-lib'
		}
		if (hasLocalLib && pkg.devDependencies?.['emw-lib'] === 'github:eddow/emw-lib') {
			pkg.devDependencies['emw-lib'] = 'workspace:../emw-lib'
		}
		return pkg
	},
}
```

`.npmrc`:

```
engine-strict=true
```

`vercel.json` (REQUIRED — copy verbatim, see why below):

```json
{
	"$schema": "https://openapi.vercel.sh/vercel.json",
	"installCommand": "pnpm install --no-frozen-lockfile"
}
```

Why `--no-frozen-lockfile`: `package.json` declares
`emw-lib: github:eddow/emw-lib`, but `pnpmfile.mjs` rewrites it to
`workspace:../emw-lib` whenever the sibling checkout exists. The committed
`pnpm-lock.yaml` therefore records `specifier: workspace:../emw-lib`. On
Vercel only one repo is cloned, the rewrite does not apply, the spec stays
`github:…` — mismatch → `ERR_PNPM_OUTDATED_LOCKFILE` (CI defaults to
`--frozen-lockfile`). The flag lets pnpm resolve the GitHub tarball
instead of failing. Same reason `pnpmfile.mjs` mentions both installers.

## 3. `tsconfig.json`, root `biome.json`, `.gitignore`

`tsconfig.json` — identical in all three packages, copy verbatim:

```json
{
	"extends": "./.svelte-kit/tsconfig.json",
	"compilerOptions": {
		"rewriteRelativeImportExtensions": true,
		"allowJs": true,
		"checkJs": true,
		"esModuleInterop": true,
		"forceConsistentCasingInFileNames": true,
		"resolveJsonModule": true,
		"skipLibCheck": true,
		"sourceMap": true,
		"strict": true,
		"moduleResolution": "bundler"
	}
}
```

Biome: no per-app config — root `biome.json` includes `*/src/**`,
`*/*.ts/js/mjs/cjs/json`, excludes `node_modules/build/dist/package`,
`pnpm-lock.yaml`, `test-results`, `playwright-report`, `paraglide`.
Style: tabs, single quotes, `semicolons: asNeeded`, 100 cols.

`.gitignore` env rule (keep examples tracked):

```
.env
.env.*
!.env.example
!.env.test
```

## 4. `vite.config.ts` (canonical minimal — copy from `arb2b`)

```ts
import { paraglideVitePlugin } from '@inlang/paraglide-js'
import adapter from '@sveltejs/adapter-vercel'
import { sveltekit } from '@sveltejs/kit/vite'
import tailwindcss from '@tailwindcss/vite'
import { playwright } from '@vitest/browser-playwright'
import { defineConfig } from 'vitest/config'
import { migrationsPlugin } from 'emw-lib/db-server'

export default defineConfig({
	// `emw-lib` ships raw source (`./src/lib/index.ts`, incl. `.svelte.ts`
	// runes). When installed from GitHub (CI/Vercel) it lands in
	// `node_modules` as a real directory, and Vite's dependency optimizer
	// (`vite-plugin-svelte:optimize-module`) tries to pre-bundle it as plain
	// JS — choking on TS syntax (`import { type … }`) and runes (`$state`).
	// Excluding it forces both modes (local workspace link AND GitHub
	// tarball) through the same source pipeline (`vite-plugin-svelte`),
	// so local and deployed builds behave identically.
	optimizeDeps: { exclude: ['emw-lib'] },
	ssr: { noExternal: ['emw-lib'] },
	plugins: [
		migrationsPlugin({ name: '<app>-migrations' }),
		tailwindcss(),
		sveltekit({
			// Only when the app ships `src/instrumentation.server.ts`
			// (Sentry does — `arb2b` has one, `emw` doesn't): SvelteKit
			// refuses the file unless this experimental flag is set.
			// No `svelte.config.*` in this repo — config lives here inline.
			// Omit the flag when there is no instrumentation file.
			experimental: { instrumentation: { server: true } },
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true,
			},
			adapter: adapter(),
		}),
		paraglideVitePlugin({
			project: './project.inlang',
			outdir: './src/lib/paraglide',
			emitTsDeclarations: true,
		}),
	],
	test: {
		expect: { requireAssertions: true },
		projects: [
			{
				extends: './vite.config.ts',
				test: {
					name: 'client',
					browser: {
						enabled: true,
						provider: playwright(),
						instances: [{ browser: 'chromium', headless: true }],
					},
					include: ['src/**/*.svelte.{test,spec}.{js,ts}'],
					exclude: ['src/lib/server/**'],
				},
			},
			{
				extends: './vite.config.ts',
				test: {
					name: 'server',
					environment: 'node',
					include: ['src/**/*.{test,spec}.{js,ts}'],
					exclude: ['src/**/*.svelte.{test,spec}.{js,ts}'],
				},
			},
		],
	},
})
```

`emw` deltas (only if needed):
`mdsvex` preprocess + `extensions`, `VITE_BUILD_DATE` define, custom
`playwright.config.ts` (dev-server on 5559, salt cookie). Adapter is
`adapter-vercel` everywhere — all apps deploy to Vercel. `emw` has no
`src/instrumentation.server.ts`, so it omits the `experimental` flag —
keep the flag only in apps that ship the file (Sentry). Default to the
minimal above.

`playwright.config.ts` (default):

```ts
import { defineConfig } from '@playwright/test'

export default defineConfig({
	webServer: { command: 'pnpm run build && pnpm run preview', port: 4173 },
	testMatch: '**/*.e2e.{ts,js}',
})
```

## 5. i18n + shell

- `project.inlang/settings.json`: base `en`, locales `en/fr/ro`,
  `pathPattern: ./messages/{locale}.json` (copy from `arb2b`).
- `messages/{en,fr,ro}.json`: copy the three files (minimal
  `{ "hello_world": … }` stubs — replace with real copy).
- `src/app.html`: `<html lang="%paraglide.lang%" dir="%paraglide.dir%">`
  (copy from `arb2b`).
- `src/hooks.ts` (paraglide reroute — copy verbatim):

```ts
import type { Reroute } from '@sveltejs/kit'
import { deLocalizeUrl } from '$lib/paraglide/runtime'

export const reroute: Reroute = (request) => deLocalizeUrl(request.url).pathname
```

- `src/routes/+layout.svelte` + `src/routes/layout.css`
  (`@import 'tailwindcss';` + `@import 'emw-lib/theme.css';` — the shared
  light/dark tokens + native form base, so minimal apps never render UA
  white inputs in dark mode; full-shadcn apps like `emw` define their own
  tokens and skip the second import) — copy `layout.css` from `arb2b`
  (layout imports the css, sets favicon, renders hidden locale links for
  prerender discovery).
- `src/lib/assets/favicon.svg` — copy (referenced by the layout).
- `static/robots.txt` (`User-agent: *` / empty `Disallow`) — copy.
- `src/lib/index.ts` — `$lib` placeholder (`// place files …` comment).
- `src/routes/+page.svelte` + `+page.server.ts` — minimal welcome page
  exposing `locals.user` (`{ name, email } | null`); replace with real UI.

## 6. Migrate databases on build (engine lives in `emw-lib/db-server`)

The runner, the `vite build` plugin and the manual CLI all live in the lib
(`emw-lib/src/lib/db/engine.js` runtime + `server.ts` types — see the
plain-JS note below); the app keeps only its `migrations/*.sql`
files (schema is per-app by design) plus one-line wiring:

- `migrateFromDir()` — applies `*.sql` in filename order, tracks in
  `schema_migrations`, idempotent re-apply = no-op. `splitStatements()`
  splits multi-statement files client-side (Neon HTTP = one statement per
  request; handles `--`/`/* */` comments, quotes, `$tag$…$tag$`).
- `migrationsPlugin({ name })` — `apply: 'build'`, `enforce: 'pre'`, runs
  once per process (`ran` guard — `vite build` calls `buildStart` twice:
  client + server). Skips under `VITEST`/`VITEST_WORKER_ID`, warns when
  `DATABASE_URL` unset, throws on failure so broken migrations block
  deploy. Includes `loadDotenvFallback()` (`.env.production.local` →
  `.env.local` → `.env.production` → `.env`, never overrides real env).
  Pass `{ name: '<app>-migrations' }` so build logs keep the per-app prefix.
- `runDbMigrate()` — manual runner (same logic as the plugin). Hosts keep
  a thin `scripts/db-migrate.mjs` wrapper (5 lines, `runDbMigrate` +
  log line) behind the `db:migrate` script, so `pnpm run db:migrate`
  works locally; CI/CD and deploy go through the plugin.

Wire: `migrationsPlugin({ name })` first in `vite.config.ts` `plugins`
(§4), `"db:migrate"` script + thin `scripts/db-migrate.mjs` wrapper +
`@neondatabase/serverless` dep (§1 — the lib's default client uses a
dynamic `neon` import; the host keeps its own copy for `db.ts` and may
inject `connect`), `migrations/0000-initialisation.sql` (better-auth core +
`user.role`/`user.locale`/`user.theme` extras — see `docs/auth.md`).

Plain-JS engine (do NOT "simplify" back to a single `.ts`):
`package.json` maps `./db-server` to `types: server.ts` +
`default: engine.js`. `engine.js` is hand-written plain JS (zero TS syntax)
because `vite.config.ts` / `scripts/db-migrate.mjs` are loaded by raw Node
— Vite does not transpile its own config's bare imports — and since Node
22.6+ type-stripping refuses TS files under `node_modules`
(`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), which is exactly where
the GitHub tarball lands on Vercel. `server.ts` holds the canonical types
and re-exports the `engine.js` runtime; the export-parity test in
`server.test.ts` keeps both in sync. Rule: `node --check engine.js` must
pass — if it doesn't, Vercel won't build either.

## 7. `src/lib/server/db.ts` (copy verbatim)

```ts
import { neon } from '@neondatabase/serverless'
import { env } from '$env/dynamic/private'

let cached: ReturnType<typeof neon> | null = null

export function isDbConfigured(): boolean {
	return Boolean(env.DATABASE_URL)
}

export function getSql(): ReturnType<typeof neon> {
	const connectionString = env.DATABASE_URL
	if (!connectionString) throw new Error('DATABASE_URL is not set')
	if (!cached) cached = neon(connectionString)
	return cached
}
```

Convention: server modules take `sql = getSql()` as default param;
routes guard with `isDbConfigured()` (503 / graceful degrade).

## 8. Auth host wiring (see `docs/auth.md` for the full guide)

1. `src/lib/server/auth.ts` — `createAuth(readAuthEnv(env), { database })`
   with `pg.Pool` (`DATABASE_URL`) (copy from `arb2b`, including the
   `building` placeholder guard: `vite build` imports server modules during
   post-build analyse with no env, and `createAuth` throws on empty secret —
   inject a placeholder when `building && !raw.AUTH_SECRET`; runtime still
   throws without a real `AUTH_SECRET`).
2. `src/lib/auth-client.ts` — `createAuthClient({ baseURL, basePath: '/auth' })` +
   `adminClient()` (copy verbatim).
3. `src/routes/login/+page.svelte` + `+page.server.ts` — server `load`
   returns `effectiveAllowlist(...)` (computed from the real `AUTH_*`
   secrets — only the id list reaches the browser);
   `<LoginScreen client={facade} allowlist={data.allowlist} />`
   (copy both verbatim; no `PUBLIC_*` mirror var needed).
4. `src/routes/auth/[...all]/+server.ts` — `GET`/`POST` →
   `auth.handler(request)` (copy verbatim; no `/api/` prefix —
   accept-header routing, server `basePath: '/auth'` lives in the lib).
5. `src/hooks.server.ts` — `sequence(handleAuth, handleParaglide)`,
   auth first (`populateLocals` + `svelteKitHandler`) (copy verbatim).
6. `src/app.d.ts` — `Locals { user, session, roles, locale, theme }`
   (copy verbatim).
7. `.env.example` — `DATABASE_URL`, `AUTH_SECRET`, `PUBLIC_BASE_URL`,
   `AUTH_ENABLED_PROVIDERS` (optional — unset = auto-detect from present
   `AUTH_*` secrets), `AUTH_TRUSTED_ORIGINS` (prod URL — otherwise 403
   `INVALID_ORIGIN`), `AUTH_<PROVIDER>_{ID,SECRET}`, `RESEND_API_KEY`
   (copy from `arb2b`).

## 9. Verify

```bash
pnpm install
pnpm run db:migrate   # needs DATABASE_URL; expect "up to date" / "applied …"
pnpm run check         # svelte-check 0 errors / 0 warnings
pnpm exec biome check src scripts
pnpm run test:unit
pnpm run build         # expect "[<app>-migrations] up to date."
```
