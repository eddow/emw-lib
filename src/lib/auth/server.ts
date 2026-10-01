/**
 * Server-only auth wiring (import via `emw-lib/auth-server`, never from
 * browser code or the client-safe barrel).
 *
 * The host app owns the DB pool + env; the lib owns the better-auth config
 * shape so every app gets the same tables, roles and preference fields.
 * Each app has its OWN database, so roles live directly on the user row —
 * no cross-app membership table.
 *
 * User extras (`additionalFields`, columns in `0000`):
 * - `role`: comma-separated roles (`admin,editor,viewer`), parsed by
 *   `parseRoles`/`serializeRoles`.
 * - `locale` / `theme`: persisted UI preferences (cookie > DB row > browser).
 */

import { type BetterAuthOptions, type BetterAuthPlugin, betterAuth } from 'better-auth'
import { admin } from 'better-auth/plugins'

export interface OAuthCred {
	clientId: string
	clientSecret: string
}

export interface AuthEnv {
	/** Session-cookie signing secret (`AUTH_SECRET`). Empty = throw. */
	secret: string
	/** Public base URL (`PUBLIC_BASE_URL`). */
	baseUrl: string
	/** `AUTH_ENABLED_PROVIDERS` allowlist — unlisted providers are rejected. */
	enabledProviders?: string
	/**
	 * Extra trusted origins (`AUTH_TRUSTED_ORIGINS`, comma-separated).
	 * The `baseUrl` origin is always trusted; list every public origin
	 * that POSTs to the auth endpoints here (e.g. the Vercel prod URL) —
	 * otherwise better-auth's origin check rejects with 403
	 * (`INVALID_ORIGIN`). Same-origin dev needs nothing.
	 */
	trustedOrigins?: string[]
	/** OAuth client pairs, present only for enabled providers. */
	google?: OAuthCred
	microsoft?: OAuthCred & { tenant?: string }
	apple?: OAuthCred
	github?: OAuthCred
	gitlab?: OAuthCred & { issuer?: string }
	linkedin?: OAuthCred
	/** Resend key for verification / reset-password emails (optional). */
	resendApiKey?: string
	/** From address for auth emails. */
	emailFrom?: string
	/**
	 * Host-built `sveltekitCookies(getRequestEvent())` plugin instance.
	 * Built in the host (it imports `$app/server`) and injected here so
	 * this module stays free of SvelteKit app imports — the lib never
	 * imports `$app/*` (same rule as `$lib/server`/env reads).
	 */
	sveltekitCookiesPlugin?: BetterAuthPlugin
}

export interface AuthDb {
	/**
	 * better-auth database handle. Pass `new Pool({ connectionString })`
	 * (`pg`, Neon-compatible) — the built-in Kysely adapter speaks Postgres
	 * directly, no ORM needed.
	 */
	database: BetterAuthOptions['database']
}

/** Split a comma-separated env/list value into trimmed non-empty parts. */
function splitList(raw: string | undefined | null): string[] {
	return (raw ?? '')
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean)
}

/** Split a stored `role` column (`"admin,editor"`) into roles. */
export function parseRoles(raw: unknown): string[] {
	if (typeof raw !== 'string') return []
	return splitList(raw)
}

/** Join roles for the `role` column. Sorted + deduped for stable writes. */
export function serializeRoles(roles: string[]): string {
	return [...new Set(roles.map((r) => r.trim()).filter(Boolean))].sort().join(',')
}

/** Provider ids enabled by the allowlist (lower-cased, deduped). */
export function enabledProviderIds(allowlist: string | undefined): Set<string> {
	return new Set(splitList(allowlist).map((s) => s.toLowerCase()))
}

/** Social provider ids the lib knows (`AuthEnv` keys). */
const SOCIAL_IDS = ['google', 'microsoft', 'apple', 'github', 'gitlab', 'linkedin'] as const

/**
 * Build an `AuthEnv` from a raw env record (e.g. SvelteKit's
 * `$env/dynamic/private` MERGED with `$env/dynamic/public` — `PUBLIC_*`
 * vars are excluded from the private module at runtime, so the host must
 * spread both: `readAuthEnv({ ...privateEnv, ...publicEnv })`).
 * Centralizes the `AUTH_*` naming convention so
 * hosts never map vars by hand:
 *
 * ```ts
 * export const auth = createAuth(readAuthEnv(env), { database: pool })
 * // login +page.server.ts
 * return { allowlist: effectiveAllowlist(readAuthEnv(env)).join(',') }
 * ```
 *
 * Both call sites read the same mapping, so adding a provider here
 * enables it in the backend and the login UI at once. The lib still
 * imports no `$env/*` itself — the host passes its `env` in.
 */
export function readAuthEnv(raw: Record<string, string | undefined>): AuthEnv {
	const cred = (prefix: string) => {
		const clientId = raw[`AUTH_${prefix}_ID`]?.trim()
		const clientSecret = raw[`AUTH_${prefix}_SECRET`]?.trim()
		return clientId && clientSecret ? { clientId, clientSecret } : undefined
	}
	const microsoft = cred('MICROSOFT')
	const gitlab = cred('GITLAB')
	return {
		secret: raw.AUTH_SECRET ?? '',
		baseUrl: raw.PUBLIC_BASE_URL ?? 'http://localhost:5173',
		enabledProviders: raw.AUTH_ENABLED_PROVIDERS,
		trustedOrigins: splitList(raw.AUTH_TRUSTED_ORIGINS).length
			? splitList(raw.AUTH_TRUSTED_ORIGINS)
			: undefined,
		google: cred('GOOGLE'),
		microsoft: microsoft
			? {
					...microsoft,
					...(raw.AUTH_MICROSOFT_TENANT?.trim()
						? { tenant: raw.AUTH_MICROSOFT_TENANT.trim() }
						: {}),
				}
			: undefined,
		apple: cred('APPLE'),
		github: cred('GITHUB'),
		gitlab: gitlab
			? {
					...gitlab,
					...(raw.AUTH_GITLAB_ISSUER?.trim() ? { issuer: raw.AUTH_GITLAB_ISSUER.trim() } : {}),
				}
			: undefined,
		linkedin: cred('LINKEDIN'),
		resendApiKey: raw.RESEND_API_KEY,
		emailFrom: raw.EMAIL_FROM,
	}
}

/**
 * Effective login flows: what the login UI should actually offer.
 * Single source of truth — a provider appears iff it is *functional*:
 * its `AUTH_<ID>_{ID,SECRET}` pair is present, intersected with the
 * `AUTH_ENABLED_PROVIDERS` allowlist when set. Unset allowlist = auto:
 * `email` + every configured social provider. This is what the host's
 * login `load` returns, so adding secrets is enough — no public mirror
 * var to keep in sync (secrets never leave the server).
 */
export function effectiveAllowlist(env: AuthEnv): string[] {
	const allowed = enabledProviderIds(env.enabledProviders)
	const hasAllowlist = allowed.size > 0
	const out: string[] = []
	if (!hasAllowlist || allowed.has('email')) out.push('email')
	for (const id of SOCIAL_IDS) {
		const cred: OAuthCred | undefined = env[id]
		if (cred?.clientId && cred?.clientSecret && (!hasAllowlist || allowed.has(id))) out.push(id)
	}
	return out
}

function buildSocialProviders(env: AuthEnv): Record<string, OAuthCred> {
	const effective = new Set(effectiveAllowlist(env))
	const out: Record<string, OAuthCred> = {}
	for (const id of SOCIAL_IDS) {
		const cred: OAuthCred | undefined = env[id]
		if (effective.has(id) && cred?.clientId && cred?.clientSecret) out[id] = cred
	}
	return out
}

/**
 * Build the better-auth instance for the host app. Call once
 * (`src/lib/server/auth.ts`: `export const auth = createAuth(env, db)`).
 */
export function createAuth(env: AuthEnv, db: AuthDb) {
	if (!env.secret) throw new Error('createAuth: AUTH_SECRET is not set')
	const effective = new Set(effectiveAllowlist(env))
	return betterAuth({
		secret: env.secret,
		baseURL: env.baseUrl,
		// Accept-header routing (no `/api/` prefix): the host mounts auth
		// at `src/routes/auth/[...all]/+server.ts` and the client uses
		// `basePath: '/auth'` — both sides must agree (see `docs/auth.md`).
		basePath: '/auth',
		trustedOrigins: env.trustedOrigins,
		database: db.database,
		emailAndPassword: {
			enabled: effective.has('email'),
			requireEmailVerification: false,
			sendResetPassword: async ({ user, url }) => {
				if (!env.resendApiKey) {
					console.warn(`[auth] password reset for ${user.email}: ${url} (RESEND_API_KEY unset)`)
					return
				}
				await fetch('https://api.resend.com/emails', {
					method: 'POST',
					headers: {
						authorization: `Bearer ${env.resendApiKey}`,
						'content-type': 'application/json',
					},
					body: JSON.stringify({
						from: env.emailFrom ?? 'noreply@localhost',
						to: user.email,
						subject: 'Reset your password',
						text: `Reset your password: ${url}`,
					}),
				})
			},
		},
		socialProviders: buildSocialProviders(env),
		user: {
			additionalFields: {
				role: { type: 'string', required: false, defaultValue: 'viewer', input: false },
				locale: { type: 'string', required: false, input: true },
				theme: { type: 'string', required: false, input: true },
			},
		},
		plugins: [
			admin({ defaultRole: 'viewer' }),
			...(env.sveltekitCookiesPlugin ? [env.sveltekitCookiesPlugin] : []),
		],
	})
}

export type Auth = ReturnType<typeof createAuth>

/** Session + user as resolved in hooks (`auth.api.getSession`). */
export interface ResolvedSession {
	user: {
		id: string
		email: string
		name: string | null
		image: string | null
		emailVerified: boolean
		role?: string | null
		locale?: string | null
		theme?: string | null
	}
	session: { id: string; userId: string; expiresAt: Date }
}

/**
 * Resolve the session for a request. Returns `null` when signed out —
 * callers redirect to `/login` (pages) or 401 (endpoints).
 */
export async function resolveSession(
	auth: Auth,
	headers: Headers
): Promise<ResolvedSession | null> {
	try {
		const data = await auth.api.getSession({ headers })
		return (data as ResolvedSession | null) ?? null
	} catch {
		return null
	}
}

/**
 * Populate `event.locals` from the request session
 * (`user`/`session`/`roles`/`locale`/`theme`). The host calls this FIRST
 * in its auth handle, then delegates to better-auth's `svelteKitHandler`
 * (which mounts `/auth/*`) — the lib never imports
 * `better-auth/svelte-kit` or `$app/*` (host injects both, same rule as
 * `FetchFn`/`baseUrl`: the lib owns the shape, the host owns the env).
 *
 * `App.Locals` stays host-owned (each app declares it in `app.d.ts`);
 * this writes the same keys via a structural type so the lib never
 * imports the host's `app.d.ts`.
 *
 * ```ts
 * // hooks.server.ts (host)
 * const handleAuth: Handle = ({ event, resolve }) => {
 * 	await populateLocals(auth, event)
 * 	return svelteKitHandler({ event, resolve, auth, building })
 * }
 * export const handle: Handle = sequence(handleAuth, handleParaglide, ...)
 * ```
 */
export async function populateLocals(
	auth: Auth,
	event: {
		request: { headers: Headers }
		locals: {
			user?: ResolvedSession['user'] | null
			session?: ResolvedSession['session'] | null
			roles?: string[]
			locale?: string | null
			theme?: string | null
		}
	}
): Promise<void> {
	const session = await resolveSession(auth, event.request.headers)
	event.locals.user = session?.user ?? null
	event.locals.session = session?.session ?? null
	event.locals.roles = parseRoles(session?.user?.role)
	event.locals.locale = session?.user?.locale ?? null
	event.locals.theme = session?.user?.theme ?? null
}
