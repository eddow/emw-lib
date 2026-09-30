/**
 * Auth — client-safe user/role surface.
 *
 * Each app owns its own DB (per-app users table), so roles live directly on
 * the user: `{ user: roles }` — no per-app nesting. The host app registers
 * its domain (`registerDomain`) so role checks stay app-scoped without a
 * shared cross-app table.
 *
 * Client-safe: no `node:` imports, no `$lib/server`, no env reads. The host
 * injects everything (same rule as the Alfred client: `FetchFn`/`baseUrl`).
 */

export type Theme = 'light' | 'dark'
export type Locale = 'en' | 'fr' | 'ro'

/** Roles known to every app. Apps extend via `registerDomain` extras. */
export const CORE_ROLES = ['admin', 'editor', 'viewer'] as const
export type CoreRole = (typeof CORE_ROLES)[number]

/** A role string — core or app-registered. */
export type Role = string

/**
 * Client-safe user shape: preferences (locale/theme) are a decision layer
 * for SSR/FE (cookie > DB > browser), roles gate access.
 */
export interface AuthUser {
	id: string
	email: string
	name: string | null
	avatarUrl: string | null
	emailVerified: boolean
	locale: Locale | null
	theme: Theme | null
	roles: Role[]
	createdAt: string
	updatedAt: string
}

/** Minimal session shape surfaced to the UI (never the raw token). */
export interface AuthSession {
	id: string
	userId: string
	expiresAt: string
}

/** What `useSession()`-style UI state resolves to. */
export interface AuthState {
	user: AuthUser | null
	session: AuthSession | null
}

/** Provider id as configured in `AUTH_ENABLED_PROVIDERS`. */
export type ProviderId =
	| 'email'
	| 'google'
	| 'microsoft'
	| 'apple'
	| 'github'
	| 'gitlab'
	| 'linkedin'
	| string

/** Provider entry for the login UI (names only — never secrets). */
export interface AuthProvider {
	id: ProviderId
	label: string
}

/** Well-known social providers with display labels. */
export const KNOWN_PROVIDERS: Record<string, string> = {
	google: 'Google',
	microsoft: 'Microsoft',
	apple: 'Apple',
	github: 'GitHub',
	gitlab: 'GitLab',
	linkedin: 'LinkedIn',
}

/**
 * Parse the `AUTH_ENABLED_PROVIDERS` allowlist (`google,microsoft,email`)
 * into UI entries. Unknown ids get a capitalised label; `email` (password)
 * and `passkey` are credential flows, not "Log in with…" buttons, so they
 * are excluded here — see `credentialFlows()`.
 */
export function listSocialProviders(allowlist: string | undefined | null): AuthProvider[] {
	if (!allowlist) return []
	const out: AuthProvider[] = []
	for (const raw of allowlist.split(',')) {
		const id = raw.trim().toLowerCase()
		if (!id || id === 'email' || id === 'passkey' || out.some((p) => p.id === id)) continue
		out.push({ id, label: KNOWN_PROVIDERS[id] ?? id.charAt(0).toUpperCase() + id.slice(1) })
	}
	return out
}

/** Which credential (non-OAuth) flows the allowlist enables. */
export function credentialFlows(allowlist: string | undefined | null): {
	emailPassword: boolean
	passkey: boolean
} {
	const ids = new Set(
		(allowlist ?? '')
			.split(',')
			.map((s) => s.trim().toLowerCase())
			.filter(Boolean)
	)
	return { emailPassword: ids.has('email'), passkey: ids.has('passkey') }
}

/** True when the user carries at least one of the required roles. */
export function hasRole(
	user: Pick<AuthUser, 'roles'> | null | undefined,
	...required: Role[]
): boolean {
	if (!user) return false
	return required.some((r) => user.roles.includes(r))
}

/**
 * Throw (HTTP 403-shaped) unless the user carries a required role.
 * Route guards catch this and redirect/render 403 — same pattern as the
 * legacy `assertPrivAuthorized`, but role-based instead of salt-based.
 */
export function requireRole(
	user: Pick<AuthUser, 'roles'> | null | undefined,
	...required: Role[]
): void {
	if (!hasRole(user, ...required)) {
		const err = new Error(`Forbidden: requires role ${required.join(' or ')}`)
		;(err as Error & { status?: number }).status = 403
		throw err
	}
}

/** True for 403-shaped errors thrown by `requireRole`. */
export function isForbidden(err: unknown): boolean {
	return typeof err === 'object' && err !== null && (err as { status?: unknown }).status === 403
}

/**
 * Preference resolution order (single place both SSR and FE consult):
 * explicit choice > stored (DB user row) > browser/system default.
 * `stored` is the DB value (`user.locale`/`user.theme`), `fallback` the
 * browser-detected default. Returns `undefined` when nothing resolves
 * (caller keeps its current default).
 */
export function resolvePreference<T extends string>(
	explicit: T | undefined | null,
	stored: T | undefined | null,
	fallback: T | undefined | null
): T | undefined {
	return explicit ?? stored ?? fallback ?? undefined
}

/** Lenient locale parse (`'FR'`, `'fr-FR'` → `'fr'`). */
export function toLocale(value: unknown): Locale | undefined {
	if (typeof value !== 'string') return undefined
	const base = value.trim().toLowerCase().split('-')[0]
	return base === 'en' || base === 'fr' || base === 'ro' ? base : undefined
}

/** Lenient theme parse. */
export function toTheme(value: unknown): Theme | undefined {
	return value === 'light' || value === 'dark' ? value : undefined
}
