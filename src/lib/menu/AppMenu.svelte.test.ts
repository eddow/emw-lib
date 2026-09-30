import { describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-svelte'
import AppMenuTestHost from './AppMenuTestHost.svelte'
import type { LocaleOption } from './types.js'

const THREE: LocaleOption[] = [
	{ code: 'en', label: 'English', flag: '🇬🇧' },
	{ code: 'fr', label: 'Français', flag: '🇫🇷' },
	{ code: 'ro', label: 'Română', flag: '🇷🇴' },
]

const ONE: LocaleOption[] = [{ code: 'en', label: 'English', flag: '🇬🇧' }]

describe('AppMenu', () => {
	it('shows the language row with several locales', async () => {
		const screen = await render(AppMenuTestHost, { locales: THREE })
		await screen.getByRole('button', { name: 'User preferences' }).click()
		await expect.element(screen.getByRole('group', { name: 'Language' })).toBeVisible()
		await expect.element(screen.getByRole('button', { name: 'Français' })).toBeVisible()
	})
	it('hides the language row with a single locale', async () => {
		const screen = await render(AppMenuTestHost, { locales: ONE })
		await screen.getByRole('button', { name: 'User preferences' }).click()
		await expect.element(screen.getByRole('group', { name: 'Theme' })).toBeVisible()
		expect(screen.container.querySelector('[aria-label="Language"]')).toBeNull()
	})
	it('hides the language row with no locales', async () => {
		const screen = await render(AppMenuTestHost, { locales: [] })
		await screen.getByRole('button', { name: 'User preferences' }).click()
		await expect.element(screen.getByRole('group', { name: 'Theme' })).toBeVisible()
		expect(screen.container.querySelector('[aria-label="Language"]')).toBeNull()
	})
	it('persists the theme choice to localStorage', async () => {
		localStorage.clear()
		const screen = await render(AppMenuTestHost, { locales: ONE })
		await screen.getByRole('button', { name: 'User preferences' }).click()
		await screen.getByRole('button', { name: 'Dark' }).click()
		expect(localStorage.getItem('EMW_THEME')).toBe('dark')
		expect(document.documentElement.classList.contains('dark')).toBe(true)
		await screen.getByRole('button', { name: 'Light' }).click()
		expect(localStorage.getItem('EMW_THEME')).toBe('light')
		expect(document.documentElement.classList.contains('dark')).toBe(false)
	})
	it('renders nav links', async () => {
		const screen = await render(AppMenuTestHost, {
			locales: ONE,
			nav: [{ kind: 'link', id: 'home', label: 'Home', href: '/', icon: '⌂' }],
		})
		await expect.element(screen.getByRole('link', { name: 'Home' })).toBeVisible()
	})
	it('hides the auth entry when no auth prop is passed', async () => {
		const screen = await render(AppMenuTestHost, { locales: ONE })
		expect(screen.container.querySelector('.user-config__auth')).toBeNull()
	})
	it('shows a login link when anonymous with a loginHref', async () => {
		const screen = await render(AppMenuTestHost, {
			locales: ONE,
			auth: { loginHref: '/login' },
		})
		await expect.element(screen.getByRole('link', { name: 'Log in' })).toBeVisible()
	})
	it('shows the user chip and signs out when signed in', async () => {
		let signedOut = false
		const screen = await render(AppMenuTestHost, {
			locales: ONE,
			auth: {
				user: { name: 'Ada', email: 'ada@example.com' },
				onSignOut: () => {
					signedOut = true
				},
			},
		})
		await screen.getByRole('button', { name: /signed in as ada/i }).click()
		expect(signedOut).toBe(true)
	})
})
