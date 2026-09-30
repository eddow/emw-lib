import { describe, expect, it } from 'vitest'
import {
	type AuthUser,
	credentialFlows,
	hasRole,
	isForbidden,
	listSocialProviders,
	requireRole,
	resolvePreference,
	toLocale,
	toTheme,
} from './types.js'

function user(roles: string[]): AuthUser {
	return {
		id: 'u1',
		email: 'a@example.com',
		name: null,
		avatarUrl: null,
		emailVerified: true,
		locale: null,
		theme: null,
		roles,
		createdAt: 't',
		updatedAt: 't',
	}
}

describe('hasRole / requireRole', () => {
	it('grants when any required role matches', () => {
		expect(hasRole(user(['viewer']), 'viewer')).toBe(true)
		expect(hasRole(user(['editor']), 'admin', 'editor')).toBe(true)
		expect(hasRole(user(['viewer']), 'admin')).toBe(false)
		expect(hasRole(null, 'viewer')).toBe(false)
		expect(hasRole(undefined, 'viewer')).toBe(false)
	})
	it('requireRole throws 403-shaped errors', () => {
		expect(() => requireRole(user(['viewer']), 'admin')).toThrowError()
		try {
			requireRole(user(['viewer']), 'admin')
			expect.unreachable()
		} catch (err) {
			expect(isForbidden(err)).toBe(true)
		}
		expect(() => requireRole(user(['admin']), 'admin')).not.toThrow()
	})
})

describe('listSocialProviders', () => {
	it('parses the allowlist, skips credential flows and dupes', () => {
		expect(listSocialProviders('google,microsoft,email,passkey')).toEqual([
			{ id: 'google', label: 'Google' },
			{ id: 'microsoft', label: 'Microsoft' },
		])
		expect(listSocialProviders('github,github')).toEqual([{ id: 'github', label: 'GitHub' }])
		expect(listSocialProviders('acme')).toEqual([{ id: 'acme', label: 'Acme' }])
		expect(listSocialProviders('')).toEqual([])
		expect(listSocialProviders(undefined)).toEqual([])
	})
	it('credentialFlows detects email + passkey', () => {
		expect(credentialFlows('google,email')).toEqual({ emailPassword: true, passkey: false })
		expect(credentialFlows('passkey')).toEqual({ emailPassword: false, passkey: true })
		expect(credentialFlows(undefined)).toEqual({ emailPassword: false, passkey: false })
	})
})

describe('resolvePreference', () => {
	it('prefers explicit > stored > fallback', () => {
		expect(resolvePreference('fr', 'en', 'ro')).toBe('fr')
		expect(resolvePreference(undefined, 'en', 'ro')).toBe('en')
		expect(resolvePreference(null, null, 'ro')).toBe('ro')
		expect(resolvePreference(null, null, null)).toBeUndefined()
	})
	it('toLocale / toTheme parse leniently', () => {
		expect(toLocale('FR')).toBe('fr')
		expect(toLocale('fr-FR')).toBe('fr')
		expect(toLocale('de')).toBeUndefined()
		expect(toTheme('dark')).toBe('dark')
		expect(toTheme('nope')).toBeUndefined()
	})
})
