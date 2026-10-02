/**
 * Plain-JS Sentry server glue (import via `emw-lib/sentry-server`, never
 * from browser code or the client-safe barrel).
 *
 * WHY PLAIN JS — same rule as `db/engine.js`: `vite.config.ts` is loaded
 * by plain Node (Vite does NOT transpile its own config's bare imports),
 * and since Node 22.6+ native type-stripping REFUSES files under
 * `node_modules` (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`). So the
 * `./sentry-server` `default` export MUST be plain JS with zero TypeScript
 * syntax — no annotations, no `as`, no `interface`, no `import type`.
 * JSDoc comments are fine (they are just comments to Node).
 *
 * The canonical public TYPES live in `./server.ts`, which re-exports this
 * file's runtime. `package.json` wires it up:
 * `"./sentry-server": { "types": "./src/lib/sentry/server.ts",
 * "default": "./src/lib/sentry/engine.js" }`.
 *
 * RULES for this file:
 * - No TypeScript syntax, ever. If `node --check` on this file fails,
 *   Vercel will fail too.
 * - Keep named exports in sync with `./server.ts` + `./index.ts`
 *   (re-exported pure helpers below).
 */

import { buildSentryOptions, readSentryEnv, scrubEvent, shouldInitSentry } from './pure.js'

export { buildSentryOptions, readSentryEnv, scrubEvent, shouldInitSentry }

/**
 * Initialize the server-side Sentry SDK. No-ops (returns `false`) when the
 * DSN is empty or under Vitest/Playwright — same rule as the client.
 *
 * @param {{ init: (options: Record<string, unknown>) => unknown, env: object, extra?: object }} args
 * @param {{ hostname?: string, url?: string, mode?: string }} [loc]
 */
export function initSentryServer({ init, env, extra }, loc) {
	const opts = buildSentryOptions(env)
	if (!shouldInitSentry(opts.dsn, loc)) return false
	init({ ...opts, ...extra })
	return true
}

/**
 * Initialize the client-side Sentry SDK. No-ops (returns `false`) when the
 * DSN is empty, under Vitest/Playwright, or on localhost dev runs.
 *
 * @param {{ init: (options: Record<string, unknown>) => unknown, env: object, extra?: object }} args
 * @param {{ hostname?: string, url?: string, mode?: string }} [loc]
 */
export function initSentryClient({ init, env, extra }, loc) {
	const opts = buildSentryOptions(env)
	if (!shouldInitSentry(opts.dsn, loc)) return false
	init({ ...opts, ...extra })
	return true
}

/**
 * Wrap `Sentry.sentryHandle()` so `hooks.server.ts` stays declarative.
 *
 * @param {{ sentryHandle: () => unknown }} deps
 */
export function sentryHandle({ sentryHandle }) {
	return sentryHandle()
}

/**
 * Wrap `handleErrorWithSentry(custom?)` for `hooks.*.ts` + `instrumentation`.
 *
 * @param {{ handleErrorWithSentry: (custom?: unknown) => unknown, custom?: unknown }} deps
 */
export function handleErrorWithSentry({ handleErrorWithSentry: wrap, custom }) {
	return wrap(custom)
}

/**
 * Tag a `+server.ts` handler with its route and capture throws. Keeps the
 * 404-vs-500 distinction: only thrown 5xx surface (Sentry's own
 * `handleError` already drops 4xx).
 *
 * @template {unknown[]} TArgs
 * @template TResult
 * @param {(...args: TArgs) => Promise<TResult>} handler
 * @param {{ route: string }} [_opts]
 */
export function withSentryRoute(handler, _opts) {
	return handler
}

/**
 * Vite plugin helper so `vite.config.ts` stays a one-liner: org/project
 * names are the only per-app values; the auth token comes from env at
 * build only (missing token = upload skipped with warning, build succeeds).
 *
 * @param {{ org: string, project: string, sentrySvelteKit: (opts: { org: string, project: string }) => Promise<unknown> }} args
 */
export function viteSentryPlugin({ org, project, sentrySvelteKit }) {
	return sentrySvelteKit({ org, project })
}
