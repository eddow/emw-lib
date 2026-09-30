import { describe, expect, it } from 'vitest'
import {
	type AuthEnv,
	effectiveAllowlist,
	enabledProviderIds,
	parseRoles,
	readAuthEnv,
	serializeRoles,
} from './server.js'

describe('parseRoles / serializeRoles', () => {
	it('splits comma lists and drops empties', () => {
		expect(parseRoles('admin,editor')).toEqual(['admin', 'editor'])
		expect(parseRoles(' admin ,, viewer ')).toEqual(['admin', 'viewer'])
		expect(parseRoles(null)).toEqual([])
		expect(parseRoles(undefined)).toEqual([])
	})
	it('serializes sorted + deduped', () => {
		expect(serializeRoles(['viewer', 'admin', 'admin'])).toBe('admin,viewer')
		expect(serializeRoles([])).toBe('')
	})
	it('round-trips', () => {
		expect(parseRoles(serializeRoles(['editor', 'admin']))).toEqual(['admin', 'editor'])
	})
})

describe('enabledProviderIds', () => {
	it('lower-cases and dedupes', () => {
		expect(enabledProviderIds('Google,google,email')).toEqual(new Set(['google', 'email']))
		expect(enabledProviderIds(undefined)).toEqual(new Set())
	})
})

function testEnv(overrides: Partial<AuthEnv> = {}): AuthEnv {
	return { secret: 's', baseUrl: 'http://localhost', ...overrides }
}

describe('effectiveAllowlist', () => {
	it('auto-detects: email + every configured social provider when no allowlist', () => {
		expect(effectiveAllowlist(testEnv())).toEqual(['email'])
		expect(
			effectiveAllowlist(testEnv({ google: { clientId: 'id', clientSecret: 'secret' } }))
		).toEqual(['email', 'google'])
	})
	it('intersects credentials with the allowlist', () => {
		const env = testEnv({
			enabledProviders: 'google,email',
			google: { clientId: 'id', clientSecret: 'secret' },
			github: { clientId: 'id', clientSecret: 'secret' },
		})
		// github has secrets but is not allowlisted → hidden
		expect(effectiveAllowlist(env)).toEqual(['email', 'google'])
	})
	it('hides allowlisted providers missing their secrets', () => {
		expect(effectiveAllowlist(testEnv({ enabledProviders: 'google,email' }))).toEqual(['email'])
	})
	it('drops email when not allowlisted', () => {
		expect(
			effectiveAllowlist(
				testEnv({
					enabledProviders: 'google',
					google: { clientId: 'id', clientSecret: 'secret' },
				})
			)
		).toEqual(['google'])
	})
})

describe('readAuthEnv', () => {
	it('maps AUTH_* vars to AuthEnv, dropping incomplete pairs', () => {
		expect(
			readAuthEnv({
				AUTH_SECRET: 's',
				PUBLIC_BASE_URL: 'https://app.example',
				AUTH_ENABLED_PROVIDERS: 'google,email',
				AUTH_TRUSTED_ORIGINS: ' https://app.example, https://preview.example ,',
				AUTH_GOOGLE_ID: 'gid',
				AUTH_GOOGLE_SECRET: 'gsecret',
				AUTH_GITHUB_ID: 'incomplete',
				RESEND_API_KEY: 're_123',
			})
		).toMatchObject({
			secret: 's',
			baseUrl: 'https://app.example',
			enabledProviders: 'google,email',
			trustedOrigins: ['https://app.example', 'https://preview.example'],
			google: { clientId: 'gid', clientSecret: 'gsecret' },
			github: undefined,
			resendApiKey: 're_123',
		})
	})
	it('leaves trustedOrigins undefined when unset', () => {
		expect(readAuthEnv({}).trustedOrigins).toBeUndefined()
	})
	it('trims values and picks up tenant/issuer extras', () => {
		const env = readAuthEnv({
			AUTH_MICROSOFT_ID: ' mid ',
			AUTH_MICROSOFT_SECRET: ' msecret ',
			AUTH_MICROSOFT_TENANT: ' tenant-1 ',
			AUTH_GITLAB_ID: ' glid ',
			AUTH_GITLAB_SECRET: ' glsecret ',
			AUTH_GITLAB_ISSUER: ' https://gitlab.example ',
		})
		expect(env.microsoft).toEqual({
			clientId: 'mid',
			clientSecret: 'msecret',
			tenant: 'tenant-1',
		})
		expect(env.gitlab).toEqual({
			clientId: 'glid',
			clientSecret: 'glsecret',
			issuer: 'https://gitlab.example',
		})
	})
	it('feeds effectiveAllowlist end to end', () => {
		const env = readAuthEnv({
			AUTH_GOOGLE_ID: 'gid',
			AUTH_GOOGLE_SECRET: 'gsecret',
		})
		expect(effectiveAllowlist(env)).toEqual(['email', 'google'])
	})
})
