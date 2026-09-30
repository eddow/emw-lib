<script lang="ts">
	import AppMenu from './AppMenu.svelte'
	import type { LocaleOption, NavItem } from './types.js'

	let {
		nav = [],
		locales = [],
		showTheme = true
	}: {
		nav?: NavItem[]
		locales?: LocaleOption[]
		showTheme?: boolean
	} = $props()
</script>

<AppMenu {nav} {locales} {showTheme} />
