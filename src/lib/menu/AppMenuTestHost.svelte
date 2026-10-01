<script lang="ts">
	import AppMenu from './AppMenu.svelte'
	import type { LocaleOption, MenuAuthState, MenuLabels, NavItem } from './types.js'

	let {
		nav = [],
		locales = [],
		showTheme = true,
		auth = null,
		labels = {},
		currentLocale = undefined,
		initialLocale = undefined,
		onLocaleChange = null
	}: {
		nav?: NavItem[]
		locales?: LocaleOption[]
		showTheme?: boolean
		auth?: MenuAuthState | null
		labels?: MenuLabels
		currentLocale?: string | undefined
		initialLocale?: string | null | undefined
		onLocaleChange?: ((locale: string) => void) | null
	} = $props()
</script>

<AppMenu {nav} {locales} {showTheme} {auth} {labels} {currentLocale} {initialLocale} {onLocaleChange} />
