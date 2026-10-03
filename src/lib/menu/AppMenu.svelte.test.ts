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
	it('keeps the plain gear when no auth prop is passed', async () => {
		const screen = await render(AppMenuTestHost, { locales: ONE })
		await expect.element(screen.getByRole('button', { name: 'User preferences' })).toBeVisible()
	})
	it('shows the account trigger instead of the gear when auth is passed', async () => {
		const screen = await render(AppMenuTestHost, {
			locales: ONE,
			auth: { loginHref: '/login' },
		})
		expect(screen.container.querySelector('.user-config__trigger--config')).toBeNull()
		await expect
			.element(screen.getByRole('button', { name: /account — signed out/i }))
			.toBeVisible()
	})
	it('shows the signed-in trigger status when a user is passed', async () => {
		const screen = await render(AppMenuTestHost, {
			locales: ONE,
			auth: { user: { name: 'Ada', email: 'ada@example.com' } },
		})
		await expect
			.element(screen.getByRole('button', { name: /account — signed in as ada/i }))
			.toBeVisible()
	})
	it('shows a login row first when anonymous with a loginHref', async () => {
		const screen = await render(AppMenuTestHost, {
			locales: ONE,
			auth: { loginHref: '/login' },
		})
		await screen.getByRole('button', { name: /account — signed out/i }).click()
		await expect.element(screen.getByRole('link', { name: /log in/i })).toBeVisible()
	})
	it('shows the sign-out row first and signs out when signed in', async () => {
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
		await screen.getByRole('button', { name: /account — signed in as ada/i }).click()
		await screen.getByRole('button', { name: /sign out/i }).click()
		expect(signedOut).toBe(true)
	})
	it('renders translated chrome via the labels prop', async () => {
		const screen = await render(AppMenuTestHost, {
			locales: ONE,
			auth: { loginHref: '/login' },
			labels: {
				site: 'Site-fr',
				userPreferences: 'Préférences',
				account: 'Compte',
				accountSignedOut: 'Compte — déconnecté',
				login: 'Se connecter',
				language: 'Langue',
				theme: 'Thème',
				lightTheme: 'Thème clair',
				light: 'Clair',
				darkTheme: 'Thème sombre',
				dark: 'Sombre',
			},
		})
		// The account trigger (visible with auth) carries the translated
		// `accountSignedOut` name; the menu rows assert the rest.
		await screen.getByRole('button', { name: 'Compte — déconnecté' }).click()
		await expect.element(screen.getByRole('group', { name: 'Compte' })).toBeVisible()
		await expect.element(screen.getByRole('link', { name: 'Se connecter' })).toBeVisible()
		await expect.element(screen.getByRole('group', { name: 'Thème' })).toBeVisible()
		await expect.element(screen.getByRole('button', { name: 'Clair' })).toBeVisible()
		await expect.element(screen.getByRole('button', { name: 'Sombre' })).toBeVisible()
	})
	it('marks the picked locale active in uncontrolled mode (arb2b stuck-locale repro)', async () => {
		localStorage.clear()
		document.cookie = 'PARAGLIDE_LOCALE=; path=/; max-age=0'
		const screen = await render(AppMenuTestHost, { locales: THREE })
		await screen.getByRole('button', { name: 'User preferences' }).click()
		const french = screen.getByRole('button', { name: 'Français' })
		await expect.element(french).toHaveAttribute('aria-pressed', 'false')
		await french.click()
		// The menu closes on pick; reopen and the new locale must be active.
		await screen.getByRole('button', { name: 'User preferences' }).click()
		await expect
			.element(screen.getByRole('button', { name: 'Français' }))
			.toHaveAttribute('aria-pressed', 'true')
		// Locale persists to the cookie only (single client↔server channel).
		expect(document.cookie).toContain('PARAGLIDE_LOCALE=fr')
	})
	it('marks the picked locale active when the host passes a stale controlled currentLocale (arb2b host shape)', async () => {
		localStorage.clear()
		document.cookie = 'PARAGLIDE_LOCALE=; path=/; max-age=0'
		let picked: string | null = null
		const screen = await render(AppMenuTestHost, {
			locales: THREE,
			currentLocale: 'en',
			onLocaleChange: (locale: string) => {
				picked = locale
			},
		})
		await screen.getByRole('button', { name: 'User preferences' }).click()
		await screen.getByRole('button', { name: 'Français' }).click()
		expect(picked).toBe('fr')
		// The host never updates `currentLocale` (stale `'en'` — the arb2b
		// shape: `currentLocale={getLocale()}` is a one-shot snapshot, not
		// reactive). The menu must still show the picked locale as active.
		await screen.getByRole('button', { name: 'User preferences' }).click()
		await expect
			.element(screen.getByRole('button', { name: 'Français' }))
			.toHaveAttribute('aria-pressed', 'true')
	})
	it('re-renders translated chrome when the host swaps the labels prop (arb2b locale-switch repro)', async () => {
		// Host shape: `labels` is a getter object over `m.*()`; on locale
		// switch the host re-renders with a new labels object. Simulate by
		// updating props — the theme row must show the translated titles,
		// not the English defaults.
		localStorage.clear()
		document.cookie = 'PARAGLIDE_LOCALE=; path=/; max-age=0'
		const english = {
			theme: 'Theme',
			lightTheme: 'Light theme',
			light: 'Light',
			darkTheme: 'Dark theme',
			dark: 'Dark',
		}
		const french = {
			theme: 'Thème',
			lightTheme: 'Thème clair',
			light: 'Clair',
			darkTheme: 'Thème sombre',
			dark: 'Sombre',
		}
		const screen = await render(AppMenuTestHost, { locales: ONE, labels: english })
		await screen.getByRole('button', { name: 'User preferences' }).click()
		await expect.element(screen.getByRole('button', { name: 'Dark' })).toBeVisible()
		// Host switches locale → new labels object.
		// FAILS BEFORE FIX: the menu keeps showing "Dark theme" because
		// arb2b's `menuLabels` getters call `m.*()` once at layout setup
		// and never re-run — `getLocale()` is a one-shot snapshot, not a
		// reactive source, so nothing invalidates the getters.
		await screen.rerender({ locales: ONE, labels: french })
		await expect.element(screen.getByRole('button', { name: 'Sombre' })).toBeVisible()
		expect(screen.container.querySelector('[title="Dark theme"]')).toBeNull()
	})
})
