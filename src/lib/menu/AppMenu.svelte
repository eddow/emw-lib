<!--
 * Unified floating app menu (client-safe, self-contained styles).
 *
 * Merges emw's `SiteTools` (left nav corner) + `UserConfig` (right config
 * menu with language + theme rows) into one component driven by props:
 *
 * When `auth` is passed, the corner trigger IS the account status
 * (`🔑` signed out, `👤` signed in) instead of the gear, and the first
 * menu row is the log-in link (anonymous) or sign-out button (signed
 * in) — its icon matches the action. Without `auth` the trigger stays
 * the plain gear (apps without auth yet).
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
 *   URLs are host callbacks/props (`onLocaleChange`, prebuilt `href`s);
 *   chrome strings come via the `labels` prop (host `m.*()`, English
 *   defaults otherwise).
 *
 * SSR (no-blink): pass the host's SSR-known `initialLocale`/`initialTheme`
 * (cookie / auth user row) so first paint already marks the active locale
 * and theme. Inline `firstPaintThemeScript()` in `app.html` so `.dark` is
 * set before hydration; `MenuPreferences.init()` then reconciles
 * (explicit > stored (locale: cookie, theme: localStorage) > browser/system)
 * — a no-op for returning visitors.
 -->

<script lang="ts">
	import { onMount } from 'svelte'
	import { MenuPreferences, type Theme } from './preferences.svelte.js'
	import {
		isMenuLink,
		type LocaleOption,
		type MenuAuthState,
		type MenuLabels,
		type MenuToolItem,
		type NavItem
	} from './types.js'

	const HIDE_DELAY_DEFAULT = 1000

	const DEFAULT_LABELS = {
		site: 'Site',
		userPreferences: 'User preferences',
		account: 'Account',
		accountSignedOut: 'Account — signed out',
		accountSignedInAs: (label: string) => `Account — signed in as ${label}`,
		login: 'Log in',
		signOut: 'Sign out',
		signedInTitle: (label: string) => `Signed in as ${label} — sign out`,
		signOutAs: (label: string) => `Sign out (${label})`,
		language: 'Language',
		theme: 'Theme',
		lightTheme: 'Light theme',
		light: 'Light',
		darkTheme: 'Dark theme',
		dark: 'Dark'
	} satisfies Required<MenuLabels>

	let {
		nav = [],
		tools = [],
		auth = null,
		locales = [],
		labels = {},
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
		/** Per-page tools rendered next to the corner trigger (e.g. CV PDF save link). */
		tools?: MenuToolItem[]
		/**
		 * Optional auth state. When passed, the corner trigger shows the
		 * account status (`🔑` signed out, `👤` signed in) instead of the
		 * gear, and the first menu row is the log-in link (anonymous +
		 * `loginHref`) or sign-out button (signed-in `user` + `onSignOut`).
		 * Omit for the plain gear (apps without auth yet).
		 */
		auth?: MenuAuthState | null
		/**
		 * Language options in display order. The language row renders only
		 * when more than one is provided — single-locale apps pass one (or
		 * none) and get no language UI.
		 */
		locales?: LocaleOption[]
		/**
		 * Translated chrome strings (group labels, theme + auth rows).
		 * Paraglide lives in the host — pass `m.*()` strings here;
		 * English defaults apply otherwise.
		 */
		labels?: MenuLabels
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
	// `lastSynced*` guards declared first: the `onLocaleChange` wrapper
	// below writes them, so they must exist before `prefs` is built.
	// Plain `$state` (not `$derived`): the sync `$effect` below writes
	// them, and `$derived` values are read-only. The two `state_referenced_locally`
	// warnings on the initializers are benign — construction-time seeding
	// is exactly the intent (same as `prefs` itself just below).
	// biome-ignore lint/correctness/useHookAtTopLevel: prefs must exist before onMount below
	// svelte-ignore state_referenced_locally: construction-time seeding, a remount picks up new values.
	let lastSyncedLocale: string | undefined = currentLocale
	// svelte-ignore state_referenced_locally: construction-time seeding, a remount picks up new values.
	let lastSyncedUserTheme: Theme | undefined = userTheme
	const prefs = new MenuPreferences({
		// svelte-ignore state_referenced_locally: construction-time seeding, a remount picks up new values.
		locales: locales.map((l) => l.code),
		// svelte-ignore state_referenced_locally: construction-time seeding, a remount picks up new values.
		initialLocale: currentLocale ?? initialLocale ?? null,
		// svelte-ignore state_referenced_locally: construction-time seeding, a remount picks up new values.
		initialTheme: userTheme ?? initialTheme ?? null,
		onLocaleChange: (locale) => {
			// Adopt the pick immediately so the active flag follows even
			// when the host's controlled `currentLocale` is a stale
			// snapshot (arb2b: one-shot `getLocale()`). The host callback
			// still runs (persist + navigate); the remount then reseeds.
			lastSyncedLocale = locale
			onLocaleChange?.(locale)
		},
		onThemeChange: (theme) => {
			lastSyncedUserTheme = theme
			onThemeChange?.(theme)
		}
	})

	onMount(() => {
		prefs.init()
	})

	$effect(() => () => prefs.dispose())

	// Controlled props win when provided; otherwise the internal store
	// owns the state. `syncLocale`/`syncTheme` adopt host updates without
	// re-firing callbacks — but a stale controlled prop (host snapshot
	// that never updates, e.g. arb2b's one-shot `getLocale()`) must not
	// clobber an explicit in-menu pick, so only sync when the host value
	// actually changed since last render.
	$effect(() => {
		if (currentLocale !== undefined && currentLocale !== lastSyncedLocale) {
			lastSyncedLocale = currentLocale
			prefs.syncLocale(currentLocale)
		}
		if (userTheme !== lastSyncedUserTheme) {
			lastSyncedUserTheme = userTheme
			if (userTheme !== undefined) prefs.syncTheme(userTheme)
		}
	})

	// The store owns the rendered locale: it seeds from
	// `currentLocale ?? initialLocale`, adopts host updates via the sync
	// effect above, and adopts in-menu picks via the `onLocaleChange`
	// wrapper — so the active flag follows even when the host's
	// controlled prop is a stale snapshot.
	const activeLocale = $derived(prefs.currentLocale)
	const activeUserTheme = $derived(userTheme ?? prefs.userTheme)
	const activeEffectiveTheme = $derived(effectiveTheme ?? prefs.effectiveTheme)
	const showLanguageRow = $derived(locales.length > 1)
	// Auth: signed-in user label (`name ?? email`). `hasAuth` swaps the
	// gear trigger for the account-status trigger; the first menu row is
	// then the log-in link (anonymous + `loginHref`) or the sign-out
	// button (signed-in `user`). No `auth` prop = plain gear.
	const authLabel = $derived(auth?.user?.name ?? auth?.user?.email ?? null)
	const showLogin = $derived(!authLabel && auth?.loginHref)
	const showUser = $derived(authLabel !== null)
	const hasAuth = $derived(auth !== null)
	const signedIn = $derived(authLabel !== null)
	const authIcon = $derived(signedIn ? '👤' : '🔑')
	const authTriggerLabel = $derived(
		signedIn && authLabel
			? (labels.accountSignedInAs?.(authLabel) ??
				DEFAULT_LABELS.accountSignedInAs(authLabel))
			: (labels.accountSignedOut ?? DEFAULT_LABELS.accountSignedOut)
	)

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

<nav class="site-tools" aria-label={labels.site ?? DEFAULT_LABELS.site}>
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

<div data-app-menu-config class="user-config" role="group" aria-label={labels.userPreferences ?? DEFAULT_LABELS.userPreferences}>
	<div
		class="user-config__bar"
		role="group"
		aria-label={labels.userPreferences ?? DEFAULT_LABELS.userPreferences}
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
		{#if hasAuth}
			<button
				type="button"
				class="user-config__trigger user-config__trigger--auth"
				class:user-config__trigger--signed-in={signedIn}
				aria-label={authTriggerLabel}
				title={authTriggerLabel}
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
				<span aria-hidden="true">{authIcon}</span>
				<span class="sr-only">{authTriggerLabel}</span>
			</button>
		{:else}
			<button
				type="button"
				class="user-config__trigger user-config__trigger--config"
				aria-label={labels.userPreferences ?? DEFAULT_LABELS.userPreferences}
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
		{/if}

		<div class="user-config__menus" role="menu">
			{#if configOpen}
				{#if showLogin}
					<div class="user-config__row user-config__row--auth" role="group" aria-label={labels.account ?? DEFAULT_LABELS.account}>
						<a
							class="user-config__option"
							href={auth?.loginHref}
							title={labels.login ?? DEFAULT_LABELS.login}
							aria-label={labels.login ?? DEFAULT_LABELS.login}
							data-sveltekit-preload-data="false"
						>
							<span aria-hidden="true">🔑</span><span class="sr-only">{labels.login ?? DEFAULT_LABELS.login}</span>
						</a>
					</div>
				{:else if showUser}
					<div class="user-config__row user-config__row--auth" role="group" aria-label={labels.account ?? DEFAULT_LABELS.account}>
						<button
							type="button"
							class="user-config__option"
							title={authLabel ? (labels.signedInTitle?.(authLabel) ?? DEFAULT_LABELS.signedInTitle(authLabel)) : (labels.signOut ?? DEFAULT_LABELS.signOut)}
							aria-label={authLabel ? (labels.signOutAs?.(authLabel) ?? DEFAULT_LABELS.signOutAs(authLabel)) : (labels.signOut ?? DEFAULT_LABELS.signOut)}
							onclick={() => {
								configOpen = false
								auth?.onSignOut?.()
							}}
						>
							<span aria-hidden="true">🚪</span><span class="sr-only">{labels.signOut ?? DEFAULT_LABELS.signOut}</span>
						</button>
					</div>
				{/if}
				{#if showLanguageRow}
					<div class="user-config__row user-config__row--locale" role="group" aria-label={labels.language ?? DEFAULT_LABELS.language}>
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
					<div class="user-config__row user-config__row--theme" role="group" aria-label={labels.theme ?? DEFAULT_LABELS.theme}>
						<button
							type="button"
							class="user-config__option"
							class:user-config__option--active={activeEffectiveTheme === 'light'}
							aria-pressed={activeUserTheme === 'light'}
							title={labels.lightTheme ?? DEFAULT_LABELS.lightTheme}
							onclick={() => chooseTheme('light')}
						>
							<span aria-hidden="true">☀</span>
							<span class="sr-only">{labels.light ?? DEFAULT_LABELS.light}</span>
						</button>
						<button
							type="button"
							class="user-config__option"
							class:user-config__option--active={activeEffectiveTheme === 'dark'}
							aria-pressed={activeUserTheme === 'dark'}
							title={labels.darkTheme ?? DEFAULT_LABELS.darkTheme}
							onclick={() => chooseTheme('dark')}
						>
							<span aria-hidden="true">☾</span>
							<span class="sr-only">{labels.dark ?? DEFAULT_LABELS.dark}</span>
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

	.user-config__trigger--signed-in {
		border-color: var(--menu-accent, var(--user-config-accent, #1a4f8a));
		box-shadow: inset 0 0 0 1px var(--menu-accent, var(--user-config-accent, #1a4f8a));
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
