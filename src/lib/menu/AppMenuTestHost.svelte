<script lang="ts">
	import AppMenu from './AppMenu.svelte'
	import type { LocaleOption, MenuAuthState, NavItem } from './types.js'

	let {
		nav = [],
		locales = [],
		showTheme = true,
		auth = null
	}: {
		nav?: NavItem[]
		locales?: LocaleOption[]
		showTheme?: boolean
		auth?: MenuAuthState | null
	} = $props()
</script>

<AppMenu {nav} {locales} {showTheme} {auth} />
