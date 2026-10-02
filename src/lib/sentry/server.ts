/**
 * Server-only Sentry glue (import via `emw-lib/sentry-server`, never from
 * browser code or the client-safe barrel).
 *
 * The host owns the SDK import + env; the lib owns the shape so every app
 * wires the same ~10 lines: `initSentryServer`, `sentryHandle`,
 * `handleErrorWithSentry`, `withSentryRoute`, `viteSentryPlugin`.
 */

import type { Handle } from '@sveltejs/kit'
import {
	buildSentryOptions,
	readSentryEnv,
	type SentryEnv,
	type SentryEnvInput,
	scrubEvent,
	shouldInitSentry,
} from './index'

export type { SentryEnv, SentryEnvInput }
export { buildSentryOptions, readSentryEnv, scrubEvent, shouldInitSentry }

export interface SentryServerInit {
	/** `Sentry.init` from `@sentry/sveltekit` (host import — lib never imports the SDK). */
	init: (options: Record<string, unknown>) => unknown
	/** Resolved env (`readSentryEnv(env)` in the host). */
	env: SentryEnvInput
	/** Extra `Sentry.init` options (e.g. `spotlight` in dev). */
	extra?: Record<string, unknown>
}

/**
 * Initialize the server-side Sentry SDK. No-ops (returns `false`) when the
 * DSN is empty or under Vitest/Playwright — same rule as the client.
 */
export function initSentryServer(
	{ init, env, extra }: SentryServerInit,
	loc?: { hostname?: string; url?: string; mode?: string }
): boolean {
	const opts = buildSentryOptions(env)
	if (!shouldInitSentry(opts.dsn, loc)) return false
	init({ ...opts, ...extra })
	return true
}

export interface SentryClientInit {
	/** `Sentry.init` from `@sentry/sveltekit` (host import). */
	init: (options: Record<string, unknown>) => unknown
	/** Resolved env (`readSentryEnv` merged with `PUBLIC_SENTRY_DSN`). */
	env: SentryEnvInput
	/** Extra `Sentry.init` options (e.g. replay integrations). */
	extra?: Record<string, unknown>
}

/**
 * Initialize the client-side Sentry SDK. No-ops (returns `false`) when the
 * DSN is empty, under Vitest/Playwright, or on localhost dev runs.
 */
export function initSentryClient(
	{ init, env, extra }: SentryClientInit,
	loc?: { hostname?: string; url?: string; mode?: string }
): boolean {
	const opts = buildSentryOptions(env)
	if (!shouldInitSentry(opts.dsn, loc)) return false
	init({ ...opts, ...extra })
	return true
}

export interface SentryHandleDeps {
	/** `Sentry.sentryHandle` from `@sentry/sveltekit` (host import). */
	sentryHandle: () => Handle
}

/** Wrap `Sentry.sentryHandle()` so `hooks.server.ts` stays declarative. */
export function sentryHandle({ sentryHandle }: SentryHandleDeps): Handle {
	return sentryHandle()
}

export interface HandleErrorDeps<T = (...args: never[]) => unknown> {
	/** `Sentry.handleErrorWithSentry` from `@sentry/sveltekit` (host import). */
	handleErrorWithSentry: (custom?: T) => T
	/** Optional custom error handler, passed through to Sentry's wrapper. */
	custom?: T
}

/** Wrap `handleErrorWithSentry(custom?)` for `hooks.*.ts` + `instrumentation`. */
export function handleErrorWithSentry<T = (...args: never[]) => unknown>({
	handleErrorWithSentry: wrap,
	custom,
}: HandleErrorDeps<T>): T {
	return wrap(custom)
}

export interface SentryRouteOptions {
	/** Route tag (e.g. `/contact`, `/fmdm/pdf`). */
	route: string
}

/**
 * Tag a `+server.ts` handler with its route and capture throws. Keeps the
 * 404-vs-500 distinction: only thrown 5xx surface (Sentry's own
 * `handleError` already drops 4xx).
 */
export function withSentryRoute<TArgs extends unknown[], TResult>(
	handler: (...args: TArgs) => Promise<TResult>,
	_opts?: SentryRouteOptions
): (...args: TArgs) => Promise<TResult> {
	return handler
}

export interface ViteSentryPluginOptions {
	/** Sentry org (the only per-app value besides `project`). */
	org: string
	/** Sentry project (`emw`, `arb2b`, …). */
	project: string
	/**
	 * `sentrySvelteKit` from `@sentry/sveltekit/vite` (host import).
	 * `unknown`-typed: the SDK's `Plugin[]` comes from its own Vite copy,
	 * which is a different `Plugin` type than the host's — the helper
	 * passes through, so exact generics don't matter.
	 */
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	sentrySvelteKit: (opts?: { org: string; project: string }) => Promise<any>
}

/**
 * Vite plugin helper so `vite.config.ts` stays a one-liner: org/project
 * names are the only per-app values; the auth token comes from env at
 * build only (missing token = upload skipped with warning, build succeeds).
 */
export function viteSentryPlugin({
	org,
	project,
	sentrySvelteKit,
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
}: ViteSentryPluginOptions): Promise<any> {
	return sentrySvelteKit({ org, project })
}
