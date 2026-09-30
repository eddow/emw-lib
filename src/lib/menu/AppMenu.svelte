<!--
 * Unified floating app menu (client-safe, self-contained styles).
 *
 * Merges emw's `SiteTools` (left nav corner) + `UserConfig` (right config
 * gear with language + theme rows) into one component driven by props:
 *
 * ```svelte
 * <AppMenu
 *   nav={[{ kind: 'link', id: 'home', label: 'Home', href: '/', icon: '⌂' }]}
 *   locales={[{ code: 'en', label: 'English', flag: '🇬🇧' }]}
 *   onLocaleChange={(l) => goto(`/${l}`)}
 * />
 * ```
 *
 * - The language row renders only when `locales.length > 1` (single-locale
 *   apps pass one entry — or none — and get no language UI).
 * - The theme row renders unless `showTheme={false}`.
 * - Flyout slots (`{ kind: 'slot', component, props }`) are host-owned
 *   components (e.g. emw's CV tag-filter panel); the lib only owns the
 *   round trigger that toggles them.
 * - The lib never imports `$app/*` or paraglide: navigation and translated
 *   URLs are host callbacks/props (`onLocaleChange`, prebuilt `href`s).
 *
 * SSR (no-blink): pass the host's SSR-known `initialLocale`/`initialTheme`
 * (cookie / auth user row) so first paint already marks the active locale
 * and theme. Inline `firstPaintThemeScript()` in `app.html` so `.dark` is
 * set before hydration; `MenuPreferences.init()` then reconciles
 * (explicit > stored > browser/system) — a no-op for returning visitors.
 -->

<script lang="ts">
	import { onMount } from 'svelte'
	import { MenuPreferences, type Theme } from './preferences.svelte.js'
	import { isMenuLink, type LocaleOption, type MenuToolItem, type NavItem } from './types.js'

	const HIDE_DELAY_DEFAULT = 1000

	let {
		nav = [],
		tools = [],
		locales = [],
		currentLocale = undefined,
		initialLocale = undefined,
		userTheme = undefined,
		initialTheme = undefined,
		effectiveTheme = undefined,
		showTheme = true,
		hideDelayMs = HIDE_DELAY_DEFAULT,
		onLocaleChange = null,
		onThemeChange = null
	}: {
		/** Left-corner nav entries (links + host-owned flyout slots). */
		nav?: NavItem[]
		/** Per-page tools rendered next to the gear (e.g. CV PDF save link). */
		tools?: MenuToolItem[]
		/**
		 * Language options in display order. The language row renders only
		 * when more than one is provided — single-locale apps pass one (or
		 * none) and get no language UI.
		 */
		locales?: LocaleOption[]
		/** Controlled locale override (host-owned state). Uncontrolled when omitted. */
		currentLocale?: string | undefined
		/** SSR-known locale for first paint (cookie / user row). */
		initialLocale?: string | null | undefined
		/** Controlled explicit theme choice. Uncontrolled when omitted. */
		userTheme?: Theme | undefined
		/** SSR-known explicit theme for first paint. */
		initialTheme?: Theme | null | undefined
		/** Controlled effective theme override (explicit ?? system). */
		effectiveTheme?: Theme | undefined
		/** Set false to hide the theme row. */
		showTheme?: boolean
		/** Hover-leave delay before flyouts close. */
		hideDelayMs?: number
		/** Called after an explicit locale choice (host navigates / re-renders). */
		onLocaleChange?: ((locale: string) => void) | null
		/** Called after an explicit theme choice. */
		onThemeChange?: ((theme: Theme) => void) | null
	} = $props()

	// Construction-time config: `locales` / initial values seed the store
	// once (same pattern as `AlfredChat`'s `history` prop — a remount picks
	// up new values). Live updates flow through the controlled
	// `currentLocale` / `userTheme` / `effectiveTheme` props instead.
	// biome-ignore lint/correctness/useHookAtTopLevel: prefs must exist before onMount below
	const prefs = new MenuPreferences({
		locales: locales.map((l) => l.code),
		initialLocale: currentLocale ?? initialLocale ?? null,
		initialTheme: userTheme ?? initialTheme ?? null,
		onLocaleChange: onLocaleChange ?? undefined,
		onThemeChange: onThemeChange ?? undefined
	})

	onMount(() => {
		prefs.init()
	})

	$effect(() => () => prefs.dispose())

	const activeLocale = $derived(currentLocale ?? prefs.currentLocale)
	const activeUserTheme = $derived(userTheme ?? prefs.userTheme)
	const activeEffectiveTheme = $derived(effectiveTheme ?? prefs.effectiveTheme)
	const showLanguageRow = $derived(locales.length > 1)

	let configOpen = $state(false)
	let configTimer: ReturnType<typeof setTimeout> | undefined = undefined
	// Uncontrolled open state per slot id (controlled slots use `open`/`onToggle`).
	let slotOpen = $state<Record<string, boolean>>({})
	let slotTimer: ReturnType<typeof setTimeout> | undefined = undefined

	function cancelConfigHide(): void {
		if (configTimer !== undefined) {
			clearTimeout(configTimer)
			configTimer = undefined
		}
	}

	function scheduleConfigHide(): void {
		cancelConfigHide()
		configTimer = setTimeout(() => {
			configOpen = false
			configTimer = undefined
		}, hideDelayMs)
	}

	function cancelSlotHide(): void {
		if (slotTimer !== undefined) {
			clearTimeout(slotTimer)
			slotTimer = undefined
		}
	}

	function scheduleSlotHide(): void {
		cancelSlotHide()
		slotTimer = setTimeout(() => {
			slotOpen = {}
			slotTimer = undefined
		}, hideDelayMs)
	}

	function isSlotOpen(id: string, controlled: boolean | undefined): boolean {
		return controlled ?? slotOpen[id] ?? false
	}

	function toggleSlot(id: string, next: boolean): void {
		cancelSlotHide()
		slotOpen = { ...slotOpen, [id]: next }
	}

	function chooseTheme(theme: Theme): void {
		prefs.setTheme(theme)
		cancelConfigHide()
	}

	function chooseLocale(code: string): void {
		prefs.setLocale(code)
		cancelConfigHide()
	}

	function handleConfigFocusOut(e: FocusEvent): void {
		const zone = e.currentTarget as HTMLElement
		if (e.relatedTarget instanceof Node && zone.contains(e.relatedTarget)) return
		configOpen = false
	}

	function handleSlotFocusOut(e: FocusEvent): void {
		const zone = e.currentTarget as HTMLElement
		if (e.relatedTarget instanceof Node && zone.contains(e.relatedTarget)) return
		slotOpen = {}
	}

	$effect(() => {
		if (!configOpen) cancelConfigHide()
		return () => cancelConfigHide()
	})

	$effect(() => {
		return () => cancelSlotHide()
	})
</script>

<svelte:document
	onclick={(e) => {
		const target = e.target as HTMLElement | null
		if (configOpen && !target?.closest?.('[data-app-menu-config]')) configOpen = false
		if (!target?.closest?.('[data-app-menu-slot]')) slotOpen = {}
	}}
/>

<nav class="site-tools" aria-label="Site">
	<div class="site-tools__bar">
		{#each nav as item (item.id)}
			{#if isMenuLink(item)}
				<a
					class="site-tools__trigger"
					href={item.href}
					aria-label={item.label}
					title={item.title ?? item.label}
					target={item.target}
					rel={item.rel}
					aria-current={item.active ? 'page' : undefined}
					data-sveltekit-preload-data={item.preload === false ? 'false' : undefined}
				>
					<span aria-hidden="true">{item.icon}</span>
					<span class="sr-only">{item.label}</span>
				</a>
			{:else}
				{@const C = item.component}
				{@const open = isSlotOpen(item.id, item.open)}
				<div
					class="site-tools__slot-zone"
					data-app-menu-slot={item.id}
					role="group"
					aria-label={item.label}
					onmouseenter={cancelSlotHide}
					onmouseleave={scheduleSlotHide}
					onfocusout={handleSlotFocusOut}
				>
					<button
						type="button"
						class="site-tools__trigger"
						aria-label={item.label}
						title={item.title ?? item.label}
						aria-expanded={open}
						aria-haspopup="true"
						onmouseenter={cancelSlotHide}
						onclick={() => {
							const next = !open
							item.onToggle?.(next)
							if (item.open === undefined) toggleSlot(item.id, next)
						}}
					>
						<span aria-hidden="true">{item.icon}</span>
						<span class="sr-only">{item.label}</span>
					</button>
					{#if open}
						<div class="site-tools__menu" role="group" aria-label={item.label}>
							<C {...item.props ?? {}} />
						</div>
					{/if}
				</div>
			{/if}
		{/each}
	</div>
</nav>

<div data-app-menu-config class="user-config" role="group" aria-label="User preferences">
	<div
		class="user-config__bar"
		role="group"
		aria-label="User preferences"
		onmouseenter={() => {
			cancelConfigHide()
			configOpen = true
		}}
		onmouseleave={scheduleConfigHide}
		onfocusout={handleConfigFocusOut}
	>
		{#each tools as tool (tool.id)}
			<a
				class="user-config__trigger user-config__tool"
				aria-label={tool.label}
				title={tool.label}
				href={tool.href}
				download={tool.download ? '' : undefined}
				target={tool.target}
				rel={tool.rel}
				data-sveltekit-preload-data="false"
			>
				<span aria-hidden="true">{tool.icon}</span>
				<span class="sr-only">{tool.label}</span>
			</a>
		{/each}
		<button
			type="button"
			class="user-config__trigger user-config__trigger--config"
			aria-label="User preferences"
			aria-expanded={configOpen}
			aria-haspopup="true"
			onmouseenter={() => {
				cancelConfigHide()
				configOpen = true
			}}
			onclick={() => {
				configOpen = true
				cancelConfigHide()
			}}
		>
			<span class="user-config__icon" aria-hidden="true"> ⚙ </span>
		</button>

		<div class="user-config__menus" role="menu">
			{#if configOpen}
				{#if showLanguageRow}
					<div class="user-config__row user-config__row--locale" role="group" aria-label="Language">
						{#each locales as locale (locale.code)}
							<button
								type="button"
								class="user-config__option user-config__option--flag"
								class:user-config__option--active={activeLocale === locale.code}
								aria-pressed={activeLocale === locale.code}
								title={locale.label}
								onclick={() => chooseLocale(locale.code)}
							>
								<span aria-hidden="true">{locale.flag ?? locale.code}</span>
								<span class="sr-only">{locale.label}</span>
							</button>
						{/each}
					</div>
				{/if}
				{#if showTheme}
					<div class="user-config__row user-config__row--theme" role="group" aria-label="Theme">
						<button
							type="button"
							class="user-config__option"
							class:user-config__option--active={activeEffectiveTheme === 'light'}
							aria-pressed={activeUserTheme === 'light'}
							title="Light theme"
							onclick={() => chooseTheme('light')}
						>
							<span aria-hidden="true">☀</span>
							<span class="sr-only">Light</span>
						</button>
						<button
							type="button"
							class="user-config__option"
							class:user-config__option--active={activeEffectiveTheme === 'dark'}
							aria-pressed={activeUserTheme === 'dark'}
							title="Dark theme"
							onclick={() => chooseTheme('dark')}
						>
							<span aria-hidden="true">☾</span>
							<span class="sr-only">Dark</span>
						</button>
					</div>
				{/if}
			{/if}
		</div>
	</div>
</div>

<style>
	/* Copied from emw's `SiteTools.svelte` + `UserConfig.svelte` (generic
	 * parts only — emw-specific icon artwork and tag-filter rows stay in
	 * host slot components). `--menu-*` is canonical; `--user-config-*`
	 * aliases keep existing host overrides working. */
	.site-tools {
		position: fixed;
		top: 1rem;
		left: 1rem;
		z-index: 50;
	}

	.site-tools__bar {
		display: flex;
		align-items: flex-start;
		gap: 0.5rem;
	}

	.site-tools__slot-zone {
		position: relative;
		display: flex;
		align-items: flex-start;
	}

	.site-tools__trigger {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 2.5rem;
		height: 2.5rem;
		border-radius: 9999px;
		border: 1px solid var(--menu-border, var(--user-config-border, #d1d5db));
		background: var(--menu-bg, var(--user-config-bg, #ffffff));
		color: var(--menu-fg, var(--user-config-fg, #111827));
		cursor: pointer;
		font-size: 1.1rem;
		line-height: 1;
		text-decoration: none;
	}

	.site-tools__trigger:hover {
		border-color: var(--menu-accent, var(--user-config-accent, #1a4f8a));
	}

	.site-tools__trigger[aria-current='page'] {
		border-color: var(--menu-accent, var(--user-config-accent, #1a4f8a));
		box-shadow: inset 0 0 0 1px var(--menu-accent, var(--user-config-accent, #1a4f8a));
	}

	.site-tools__menu {
		position: absolute;
		top: calc(100% + 0.5rem);
		left: 0;
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		padding: 0.25rem;
		border-radius: 0.5rem;
		border: 1px solid var(--menu-border, var(--user-config-border, #d1d5db));
		background: var(--menu-bg, var(--user-config-bg, #ffffff));
		box-shadow: 0 4px 12px rgb(0 0 0 / 0.12);
		min-width: 11rem;
	}

	.user-config {
		position: fixed;
		top: 1rem;
		right: 1rem;
		z-index: 50;
	}

	.user-config__bar {
		position: relative;
		display: flex;
		align-items: flex-start;
		gap: 0.5rem;
	}

	.user-config__trigger {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 2.5rem;
		height: 2.5rem;
		border-radius: 9999px;
		border: 1px solid var(--menu-border, var(--user-config-border, #d1d5db));
		background: var(--menu-bg, var(--user-config-bg, #ffffff));
		color: var(--menu-fg, var(--user-config-fg, #111827));
		cursor: pointer;
		font-size: 1.1rem;
		line-height: 1;
	}

	.user-config__trigger:hover {
		border-color: var(--menu-accent, var(--user-config-accent, #1a4f8a));
	}

	.user-config__menus {
		position: absolute;
		top: calc(100% + 0.5rem);
		right: 0;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		align-items: flex-end;
		pointer-events: none;
	}

	.user-config__row {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		padding: 0.25rem;
		border-radius: 0.5rem;
		border: 1px solid var(--menu-border, var(--user-config-border, #d1d5db));
		background: var(--menu-bg, var(--user-config-bg, #ffffff));
		box-shadow: 0 4px 12px rgb(0 0 0 / 0.12);
		pointer-events: auto;
	}

	.user-config__option {
		display: flex;
		align-items: center;
		justify-content: center;
		min-width: 2rem;
		height: 2rem;
		padding: 0 0.4rem;
		border-radius: 0.375rem;
		border: 1px solid transparent;
		background: transparent;
		color: var(--menu-fg, var(--user-config-fg, #111827));
		cursor: pointer;
		font-size: 0.8rem;
		font-weight: 600;
	}

	.user-config__option:hover {
		border-color: var(--menu-accent, var(--user-config-accent, #1a4f8a));
	}

	.user-config__option--active {
		background: var(--menu-accent, var(--user-config-accent, #1a4f8a));
		border-color: var(--menu-accent, var(--user-config-accent, #1a4f8a));
		color: #ffffff;
	}

	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
		white-space: nowrap;
		border: 0;
	}

	@media print {
		.site-tools,
		.user-config {
			display: none;
		}
	}
</style>
