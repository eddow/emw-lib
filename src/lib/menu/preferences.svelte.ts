/**
 * Portable theme + locale preferences (client-safe, framework-free core with
 * a thin Svelte runes shell).
 *
 * Port of `emw`'s `src/lib/preferences.svelte.ts` minus the emw-only deps:
 * no `$app/*`, no `$lib/locale`, no paraglide runtime. The host owns
 * navigation and message dictionaries — this module only persists the
 * choice (localStorage + cookie) and applies the theme to the DOM.
 *
 * SSR contract (no-blink): the host renders the first paint from its own
 * SSR-known values (`initialLocale`/`initialTheme`, e.g. from the auth user
 * row via `populateLocals`, or the `PARAGLIDE_LOCALE` cookie), and inlines
 * {@link FIRST_PAINT_THEME_SCRIPT} in `app.html` so `.dark` is set before
 * hydration. `MenuPreferences` then reconciles client-side on `init()`:
 * explicit in-memory choice > stored (localStorage, then cookie) >
 * browser/system default. Because the script and the store share the same
 * storage key, the common case (returning visitor with a stored choice)
 * paints correctly and `init()` is a no-op for the theme.
 */

import { type Theme, toLocale, toTheme } from '../auth/types.js'

export type { Theme }

/** localStorage key for the explicit theme choice (theme never touches cookies). */
export const MENU_THEME_KEY = 'EMW_THEME'

/** localStorage + cookie key for the explicit locale choice. */
export const MENU_LOCALE_KEY = 'PARAGLIDE_LOCALE'

/** Cookie max-age for the locale choice (1 year, mirrors paraglide default). */
export const MENU_LOCALE_COOKIE_MAX_AGE = 34560000

/**
 * Inline in the host's `app.html` `<head>` (before `%sveltekit.head%`) so
 * the theme class is set before first paint — no dark/light flash.
 * Priority mirrors `init()`: localStorage > `prefers-color-scheme`.
 * `key` must match the `themeKey` passed to `MenuPreferences` (default
 * {@link MENU_THEME_KEY}).
 */
export function firstPaintThemeScript(key: string = MENU_THEME_KEY): string {
	return `(function(){try{var t=localStorage.getItem(${JSON.stringify(key)});if(t!=='light'&&t!=='dark'){t=window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';}if(t==='dark')document.documentElement.classList.add('dark');document.documentElement.style.colorScheme=t;}catch(e){}})();`
}

/** Options for {@link MenuPreferences}. */
export interface MenuPreferencesOptions {
	/** Supported locale codes, in display order. Default `['en']`. */
	locales?: readonly string[]
	/** localStorage key for the theme. Default {@link MENU_THEME_KEY}. */
	themeKey?: string
	/** localStorage + cookie key for the locale. Default {@link MENU_LOCALE_KEY}. */
	localeKey?: string
	/** Cookie max-age for the locale. Default {@link MENU_LOCALE_COOKIE_MAX_AGE}. */
	localeCookieMaxAge?: number
	/**
	 * SSR-known locale (cookie / user row). Rendered by the host on first
	 * paint; `init()` keeps it unless a stored or explicit choice wins.
	 */
	initialLocale?: string | null
	/** SSR-known effective theme. Same contract as `initialLocale`. */
	initialTheme?: Theme | null
	/** Called after an explicit locale choice (host navigates / re-renders). */
	onLocaleChange?: (locale: string) => void
	/** Called after an explicit theme choice. */
	onThemeChange?: (theme: Theme) => void
}

function isBrowser(): boolean {
	return typeof window !== 'undefined' && typeof document !== 'undefined'
}

function readCookie(name: string): string | undefined {
	if (!isBrowser()) return undefined
	try {
		const prefix = `${name}=`
		for (const part of document.cookie.split(';')) {
			const trimmed = part.trim()
			if (trimmed.startsWith(prefix)) return decodeURIComponent(trimmed.slice(prefix.length))
		}
	} catch {
		// storage unavailable
	}
	return undefined
}

function writeCookie(name: string, value: string, maxAge: number): void {
	if (!isBrowser()) return
	try {
		document.cookie = `${name}=${encodeURIComponent(value)}; path=/; max-age=${maxAge}`
	} catch {
		// storage unavailable
	}
}

function readStoredTheme(themeKey: string): Theme | undefined {
	if (!isBrowser()) return undefined
	try {
		return toTheme(localStorage.getItem(themeKey))
	} catch {
		return undefined
	}
}

function writeStoredTheme(themeKey: string, theme: Theme): void {
	if (!isBrowser()) return
	try {
		localStorage.setItem(themeKey, theme)
	} catch {
		// storage unavailable
	}
}

function readStoredLocale(localeKey: string): string | undefined {
	if (!isBrowser()) return undefined
	try {
		const fromStorage = toLocale(localStorage.getItem(localeKey))
		if (fromStorage) return fromStorage
	} catch {
		// storage unavailable — fall through to cookie
	}
	return toLocale(readCookie(localeKey))
}

function writeStoredLocale(localeKey: string, maxAge: number, locale: string): void {
	if (!isBrowser()) return
	try {
		localStorage.setItem(localeKey, locale)
	} catch {
		// storage unavailable — cookie still persists the choice
	}
	writeCookie(localeKey, locale, maxAge)
}

function detectSystemTheme(): Theme {
	if (!isBrowser()) return 'light'
	return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function detectBrowserLocale(locales: readonly string[], fallback: string): string {
	if (!isBrowser()) return fallback
	const langs = window.navigator.languages?.length
		? window.navigator.languages
		: [window.navigator.language]
	for (const lang of langs) {
		const parsed = toLocale(lang)
		if (parsed && locales.includes(parsed)) return parsed
	}
	return fallback
}

/** Apply the effective theme to the DOM (dark class + color scheme). */
export function applyMenuTheme(theme: Theme): void {
	if (!isBrowser()) return
	const root = document.documentElement
	root.classList.toggle('dark', theme === 'dark')
	root.style.colorScheme = theme
}

/**
 * Reactive theme + locale preferences. Instantiate per component (never a
 * module singleton — `$state` at module scope leaks across SSR renders).
 *
 * ```svelte
 * <script lang="ts">
 *   import { MenuPreferences } from 'emw-lib'
 *   const prefs = new MenuPreferences({ locales: ['en', 'fr', 'ro'] })
 *   $effect(() => () => prefs.dispose())
 * </script>
 * ```
 */
export class MenuPreferences {
	readonly locales: readonly string[]
	readonly themeKey: string
	readonly localeKey: string
	readonly localeCookieMaxAge: number
	readonly onLocaleChange: ((locale: string) => void) | null
	readonly onThemeChange: ((theme: Theme) => void) | null

	#userTheme = $state<Theme | undefined>(undefined)
	#systemDark = $state(false)
	#currentLocale = $state<string>('en')
	#initialized = $state(false)
	#mediaCleanup: (() => void) | null = null

	constructor(opts: MenuPreferencesOptions = {}) {
		this.locales = opts.locales ?? ['en']
		this.themeKey = opts.themeKey ?? MENU_THEME_KEY
		this.localeKey = opts.localeKey ?? MENU_LOCALE_KEY
		this.localeCookieMaxAge = opts.localeCookieMaxAge ?? MENU_LOCALE_COOKIE_MAX_AGE
		this.onLocaleChange = opts.onLocaleChange ?? null
		this.onThemeChange = opts.onThemeChange ?? null
		const fallback = this.locales[0] ?? 'en'
		this.#currentLocale =
			(opts.initialLocale && this.locales.includes(opts.initialLocale)
				? opts.initialLocale
				: null) ?? fallback
		if (opts.initialTheme) this.#userTheme = opts.initialTheme
	}

	/** Explicit theme choice, if any. */
	get userTheme(): Theme | undefined {
		return this.#userTheme
	}

	/** Effective theme (explicit choice, else system). */
	get effectiveTheme(): Theme {
		return this.#userTheme ?? (this.#systemDark ? 'dark' : 'light')
	}

	/** Current locale code. */
	get currentLocale(): string {
		return this.#currentLocale
	}

	/** Whether `init()` has run (always false during SSR). */
	get initialized(): boolean {
		return this.#initialized
	}

	/**
	 * Reconcile client-side once. Priority: explicit in-memory choice
	 * (constructor hints) > stored (localStorage, then cookie) >
	 * browser/system default. Idempotent.
	 */
	init(): void {
		if (!isBrowser() || this.#initialized) return
		this.#initialized = true

		this.#systemDark = detectSystemTheme() === 'dark'
		this.#userTheme = readStoredTheme(this.themeKey)

		const fallback = this.locales[0] ?? 'en'
		this.#currentLocale =
			readStoredLocale(this.localeKey) ??
			(this.locales.includes(this.#currentLocale) ? this.#currentLocale : null) ??
			detectBrowserLocale(this.locales, fallback)

		applyMenuTheme(this.effectiveTheme)

		const mq = window.matchMedia('(prefers-color-scheme: dark)')
		const onChange = (e: MediaQueryListEvent) => {
			this.#systemDark = e.matches
			if (this.#userTheme === undefined) applyMenuTheme(this.effectiveTheme)
		}
		mq.addEventListener?.('change', onChange)
		this.#mediaCleanup = () => mq.removeEventListener?.('change', onChange)
	}

	/** Persist an explicit theme choice and apply it. */
	setTheme(theme: Theme): void {
		this.#userTheme = theme
		if (isBrowser()) {
			writeStoredTheme(this.themeKey, theme)
			applyMenuTheme(theme)
		}
		this.onThemeChange?.(theme)
	}

	/**
	 * Persist an explicit locale choice. Never navigates — the host's
	 * `onLocaleChange` decides (translated slug, locale path, in-place
	 * re-render, …).
	 */
	setLocale(locale: string): void {
		if (!this.locales.includes(locale)) return
		this.#currentLocale = locale
		if (isBrowser()) writeStoredLocale(this.localeKey, this.localeCookieMaxAge, locale)
		this.onLocaleChange?.(locale)
	}

	/**
	 * Adopt an externally-owned locale (controlled `currentLocale` prop
	 * catching up) without persisting or firing callbacks — the host
	 * already owns persistence + navigation for its own state.
	 */
	syncLocale(locale: string): void {
		if (!this.locales.includes(locale)) return
		this.#currentLocale = locale
	}

	/**
	 * Adopt an externally-owned theme (controlled `userTheme` prop
	 * catching up) without persisting or firing callbacks. Applies to
	 * the DOM so first paint stays in sync.
	 */
	syncTheme(theme: Theme): void {
		this.#userTheme = theme
		if (isBrowser()) applyMenuTheme(this.effectiveTheme)
	}

	/** Detach the `prefers-color-scheme` listener (call from `$effect` cleanup). */
	dispose(): void {
		this.#mediaCleanup?.()
		this.#mediaCleanup = null
	}
}
