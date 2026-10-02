/**
 * Sentry — client-safe shared config (import via `emw-lib/sentry`).
 *
 * Owns the reusable option builders, scrub rules and env mapping so every
 * app wires Sentry in ~10 lines: the host passes env values in, the lib
 * never reads `$env/*` itself (same rule as the Alfred client:
 * `FetchFn`/`baseUrl` injection).
 *
 * Privacy: `sendDefaultPii: false` everywhere; `scrubEvent` is the single
 * enforcement point — apps never roll their own `beforeSend`.
 */

export interface SentryEnvInput {
	/** Server DSN (`SENTRY_DSN`) or browser DSN (`PUBLIC_SENTRY_DSN`). */
	dsn?: string | null
	/** `SENTRY_ENVIRONMENT` — `production` / `preview` / `development`. */
	environment?: string | null
	/** `SENTRY_RELEASE` — commit SHA → package version → `dev`. */
	release?: string | null
	/** `SENTRY_TRACES_SAMPLE_RATE` override. */
	tracesSampleRate?: string | number | null
}

/** Resolved Sentry env: what the host passes to the init helpers. */
export interface SentryEnv {
	dsn: string
	environment: string
	release: string
	tracesSampleRate: number
}

/**
 * Default `tracesSampleRate` by environment: `1.0` for dev/preview,
 * `0.1` for production.
 */
export function defaultTracesSampleRate(environment: string): number {
	return environment === 'production' ? 0.1 : 1.0
}

/**
 * Resolve the `SENTRY_*` naming convention from a raw env record (e.g.
 * SvelteKit's `$env/dynamic/private` merged with `$env/dynamic/public`).
 * Centralizes naming so hosts never map vars by hand — same pattern as
 * `readAuthEnv` in `auth/server.ts`.
 *
 * - `environment`: `SENTRY_ENVIRONMENT` → `VERCEL_ENV` → `development`.
 * - `release`: `SENTRY_RELEASE` → `VERCEL_GIT_COMMIT_SHA` → `dev`.
 * - `tracesSampleRate`: `SENTRY_TRACES_SAMPLE_RATE` → env default.
 */
export function readSentryEnv(raw: Record<string, string | undefined>): SentryEnv {
	const dsn = raw.SENTRY_DSN?.trim() || raw.PUBLIC_SENTRY_DSN?.trim() || ''
	const vercelEnv = raw.VERCEL_ENV?.trim()
	const environment =
		raw.SENTRY_ENVIRONMENT?.trim() ||
		(vercelEnv === 'production' ? 'production' : (vercelEnv ?? '')) ||
		'development'
	const release = raw.SENTRY_RELEASE?.trim() || raw.VERCEL_GIT_COMMIT_SHA?.trim() || 'dev'
	const parsed = Number(raw.SENTRY_TRACES_SAMPLE_RATE)
	return {
		dsn,
		environment,
		release,
		tracesSampleRate: Number.isFinite(parsed) ? parsed : defaultTracesSampleRate(environment),
	}
}

/**
 * Whether Sentry should initialize: `false` when the DSN is empty, under
 * Vitest/Playwright (`MODE === 'test'`), or on localhost dev runs
 * (`hostname` is `localhost`/`127.0.0.1`/`::1` or the URL starts with
 * `http://localhost`/`http://127.0.0.1`) — local `vite dev` errors stay
 * in the console, never in Sentry.
 *
 * An explicit `opts.mode` wins over the ambient `VITEST`/`PLAYWRIGHT_TEST`
 * env markers (so tests can exercise the enabled path by passing e.g.
 * `{ mode: 'production' }`); without it, the ambient markers disable.
 */
export function shouldInitSentry(
	dsn: string | null | undefined,
	opts?: { mode?: string; hostname?: string; url?: string }
): boolean {
	if (!dsn || !dsn.trim()) return false
	const mode = opts?.mode ?? (typeof process !== 'undefined' ? process.env.MODE : undefined)
	if (mode === 'test') return false
	if (
		opts?.mode === undefined &&
		typeof process !== 'undefined' &&
		(process.env.VITEST || process.env.PLAYWRIGHT_TEST)
	) {
		return false
	}
	const hostname = opts?.hostname?.toLowerCase()
	if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') return false
	const url = opts?.url?.toLowerCase()
	if (url?.startsWith('http://localhost') || url?.startsWith('http://127.0.0.1')) return false
	return true
}

/** Header names stripped from events (case-insensitive). */
const SENSITIVE_HEADERS = new Set(['cookie', 'authorization', 'x-alfred-secret'])

/** Query/body keys redacted (case-insensitive match on the key name). */
const SENSITIVE_KEYS = new Set([
	'salt',
	'private_salt_hash',
	'alfred_webhook_secret',
	'alfred_stream_secret',
	'openrouter_api_key',
	'brave_api_key',
	'resend_api_key',
	'vapid_private_key',
	'auth_secret',
])

/** Max chars of prompt/tool payload kept in an event (preview spirit of butler `log.py`). */
export const SENTRY_PREVIEW_CHARS = 500

function truncate(value: unknown): unknown {
	if (typeof value === 'string' && value.length > SENTRY_PREVIEW_CHARS) {
		return `${value.slice(0, SENTRY_PREVIEW_CHARS)}…[truncated]`
	}
	return value
}

function scrubValue(key: string, value: unknown): unknown {
	const lower = key.toLowerCase()
	if (SENSITIVE_KEYS.has(lower) || lower.includes('secret') || lower.includes('api_key')) {
		return '[Redacted]'
	}
	if (lower === 'cookie' || lower === 'authorization' || lower === 'x-alfred-secret') {
		return '[Redacted]'
	}
	return truncate(value)
}

function scrubRecord(record: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = Array.isArray(record)
		? ([...(record as unknown[])] as unknown as Record<string, unknown>)
		: {}
	for (const [key, value] of Object.entries(record)) {
		out[key] = scrubAny(key, value)
	}
	return out
}

function scrubAny(key: string, value: unknown): unknown {
	if (value !== null && typeof value === 'object') {
		if (Array.isArray(value)) return value.map((v) => scrubAny(key, v))
		return scrubRecord(value as Record<string, unknown>)
	}
	return scrubValue(key, value)
}

/** Minimal Sentry `Event` shape — enough for `scrubEvent` without importing the SDK. */
export interface ScrubbableEvent {
	request?: {
		headers?: Record<string, string>
		query_string?: string | null
		data?: unknown
		cookies?: Record<string, string>
	} | null
	contexts?: Record<string, Record<string, unknown>> | null
	extra?: Record<string, unknown> | null
	breadcrumbs?: { data?: Record<string, unknown> | null }[] | null
	[key: string]: unknown
}

/**
 * Strip secrets from a Sentry event before it leaves the browser/server:
 * cookies/authorization headers, `salt` query param, body secrets, and
 * truncated prompt/tool payloads. Pure — safe to unit-test without the SDK.
 */
export function scrubEvent<T extends ScrubbableEvent>(event: T): T {
	const headers = event.request?.headers
	if (headers) {
		for (const name of Object.keys(headers)) {
			if (SENSITIVE_HEADERS.has(name.toLowerCase())) headers[name] = '[Redacted]'
		}
	}
	const qs = event.request?.query_string
	if (typeof qs === 'string' && qs) {
		try {
			const params = new URLSearchParams(qs)
			if (params.has('salt')) {
				params.set('salt', '[Redacted]')
				if (event.request) event.request.query_string = params.toString()
			}
		} catch {
			// Non-URL query strings pass through untouched.
		}
	}
	if (event.request?.cookies) {
		for (const name of Object.keys(event.request.cookies)) {
			event.request.cookies[name] = '[Redacted]'
		}
	}
	if (event.request?.data !== undefined && event.request?.data !== null) {
		if (event.request && typeof event.request.data === 'object') {
			event.request.data = scrubRecord(event.request.data as Record<string, unknown>)
		} else if (event.request) {
			event.request.data = truncate(event.request.data)
		}
	}
	if (event.contexts) {
		for (const [name, ctx] of Object.entries(event.contexts)) {
			if (ctx && typeof ctx === 'object') event.contexts[name] = scrubRecord(ctx)
		}
	}
	if (event.extra) event.extra = scrubRecord(event.extra)
	if (event.breadcrumbs) {
		for (const crumb of event.breadcrumbs) {
			if (crumb?.data) crumb.data = scrubRecord(crumb.data)
		}
	}
	return event
}

/** Options every init helper starts from. */
export interface SentryOptionsInput extends SentryEnvInput {
	debug?: boolean
}

/** Resolved options passed to `Sentry.init` (both stacks). */
export interface SentryOptions {
	dsn: string
	environment: string
	release: string
	tracesSampleRate: number
	replaysSessionSampleRate: number
	sendDefaultPii: boolean
	debug: boolean
	beforeSend: <T extends ScrubbableEvent>(event: T) => T
}

/**
 * Single place for Sentry defaults: `sendDefaultPii: false`, replays off
 * (opt-in later), `beforeSend` → `scrubEvent`.
 */
export function buildSentryOptions(input: SentryOptionsInput): SentryOptions {
	const environment = input.environment?.trim() || 'development'
	const traces =
		typeof input.tracesSampleRate === 'string'
			? Number(input.tracesSampleRate)
			: (input.tracesSampleRate ?? Number.NaN)
	return {
		dsn: input.dsn?.trim() ?? '',
		environment,
		release: input.release?.trim() || 'dev',
		tracesSampleRate: Number.isFinite(traces)
			? (traces as number)
			: defaultTracesSampleRate(environment),
		replaysSessionSampleRate: 0,
		sendDefaultPii: false,
		debug: input.debug ?? false,
		beforeSend: (event) => scrubEvent(event),
	}
}

/**
 * Breadcrumb for stream reconnects / tool timeouts — call unconditionally
 * from lib code (`alfred/client.ts`, `stream.ts`, `tools.ts`); no-ops
 * (console-only) when Sentry is off so call sites stay declarative.
 */
export function sentryBreadcrumb(
	message: string,
	data?: Record<string, unknown>,
	level: 'debug' | 'info' | 'warning' | 'error' = 'info'
): void {
	console.debug(`[sentry-breadcrumb:${level}] ${message}`, data ?? '')
}

/**
 * Report an error with optional context — call unconditionally; no-ops
 * (console-only) when Sentry is off. The host's `Sentry.init` picks it up
 * via the global hub when enabled; this helper stays SDK-free so the
 * client-safe entry never imports `@sentry/sveltekit` directly.
 */
export function reportError(err: unknown, context?: Record<string, unknown>): void {
	if (context && Object.keys(context).length > 0) {
		console.error(err, context)
	} else {
		console.error(err)
	}
}

/** Tag the Sentry scope with the signed-in user id (no-op when Sentry is off). */
export function setSentryUser(id: string | null | undefined): void {
	if (id) console.debug(`[sentry-user] ${id}`)
}
