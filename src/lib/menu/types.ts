import type { Component } from 'svelte'

// NOTE: `Locale`/`Theme` live in `auth/types.ts` and are already exported
// through the top-level barrel — they are intentionally NOT re-exported
// here (same `FetchFn` precedent as `alfred/index.ts`: re-exporting would
// trip svelte-check's "already exported a member"). `LocaleOption.code` is
// a plain string so single-language apps can pass any code.

/**
 * One language entry for the config gear's language row.
 * `code` is a plain string (not the lib `Locale` union) so single-language
 * apps can pass any code — or omit `locales` entirely to hide the row.
 */
export interface LocaleOption {
	/** BCP-47-ish code (`'en'`, `'fr'`, …). Matched against `currentLocale`. */
	code: string
	/** Accessible label (`'English'`, `'Français'`, …). */
	label: string
	/** Flag emoji or glyph shown on the button. Defaults to `code`. */
	flag?: string
}

/** Plain navigation link rendered in the left (site) corner. */
export interface MenuLinkItem {
	kind: 'link'
	/** Stable key. */
	id: string
	/** Accessible label + title tooltip. */
	label: string
	/** Destination URL (host-resolved — the lib never touches `$app/paths`). */
	href: string
	/** Emoji/glyph or text shown in the round trigger. */
	icon: string
	/** Tooltip override. Defaults to `label`. */
	title?: string
	/** Link target (e.g. `_blank` for external booking links). */
	target?: string
	/** Link rel (e.g. `noopener noreferrer`). */
	rel?: string
	/** Marks the entry active (`aria-current="page"` + highlight). */
	active?: boolean
	/** When false, opt out of SvelteKit preloading (`data-sveltekit-preload-data="false"`). */
	preload?: boolean
}

/**
 * Host-owned flyout slot rendered in the left (site) corner.
 * The host passes a component (e.g. emw's CV tag-filter panel or contact
 * popover trigger) — the lib only owns the round trigger button that
 * toggles it, never the slot content.
 */
export interface MenuSlotItem {
	kind: 'slot'
	/** Stable key. */
	id: string
	/** Accessible label + title tooltip. */
	label: string
	/** Emoji/glyph shown in the round trigger. */
	icon: string
	/** Tooltip override. Defaults to `label`. */
	title?: string
	/** The host component rendered when the slot is open. */
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	component: Component<any>
	/** Props forwarded to `component`. */
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	props?: Record<string, any>
	/** Controlled open state. Omit for an uncontrolled toggle. */
	open?: boolean
	/** Called when the trigger toggles (uncontrolled) or is pressed (controlled). */
	onToggle?: (open: boolean) => void
}

/** Left-corner nav entry: a link or a host-owned flyout slot. */
export type NavItem = MenuLinkItem | MenuSlotItem

/** Per-page tool rendered next to the corner trigger (e.g. emw's CV PDF save link). */
export interface MenuToolItem {
	/** Stable key. */
	id: string
	/** Accessible label + title tooltip. */
	label: string
	/** Destination URL (host-resolved). */
	href: string
	/** Emoji/glyph shown in the round trigger. */
	icon: string
	/** Render as a download link (`download=""`). */
	download?: boolean
	/** Link target. */
	target?: string
	/** Link rel. */
	rel?: string
}

/**
 * Translated UI strings for `AppMenu`'s own chrome (group labels, theme
 * row, auth row). Paraglide lives in the host app, never in `emw-lib` —
 * the host passes its `m.*()` strings (or lambdas over them for the
 * interpolated ones); English defaults apply otherwise. `nav` / `tools` /
 * `locales` labels stay host-owned (prebuilt `label` fields).
 */
export interface MenuLabels {
	/** Left-corner nav group (`aria-label`). Default `'Site'`. */
	site?: string
	/** Right-corner group + gear trigger. Default `'User preferences'`. */
	userPreferences?: string
	/** Auth row group. Default `'Account'`. */
	account?: string
	/** Account trigger when signed out. Default `'Account — signed out'`. */
	accountSignedOut?: string
	/** Account trigger when signed in. Default `(l) => `Account — signed in as ${l}``. */
	accountSignedInAs?: (label: string) => string
	/** Log-in row (`title` + `aria-label` + sr-only). Default `'Log in'`. */
	login?: string
	/** Sign-out row sr-only text. Default `'Sign out'`. */
	signOut?: string
	/** Sign-out row `title`. Default `(l) => `Signed in as ${l} — sign out``. */
	signedInTitle?: (label: string) => string
	/** Sign-out row `aria-label`. Default `(l) => `Sign out (${l})``. */
	signOutAs?: (label: string) => string
	/** Language row group. Default `'Language'`. */
	language?: string
	/** Theme row group. Default `'Theme'`. */
	theme?: string
	/** Light button `title`. Default `'Light theme'`. */
	lightTheme?: string
	/** Light button sr-only text. Default `'Light'`. */
	light?: string
	/** Dark button `title`. Default `'Dark theme'`. */
	darkTheme?: string
	/** Dark button sr-only text. Default `'Dark'`. */
	dark?: string
}

/**
 * Auth state for the config corner. When passed, the corner trigger shows
 * the account status (`🔑` signed out, `👤` signed in) instead of the gear,
 * and the first menu row is the log-in link (anonymous + `loginHref`) or
 * the sign-out button (signed-in `user` + `onSignOut`), with matching icons.
 * Client-safe: the lib never calls better-auth — the host passes a
 * `loginHref` (anonymous) or a `user` + `onSignOut` (signed in). Omit the
 * whole prop for the plain gear (e.g. apps without auth yet).
 */
export interface MenuAuthState {
	/** Signed-in display name (`name ?? email`). Omit when anonymous. */
	user?: { name?: string | null; email?: string | null } | null
	/** Where the login trigger navigates when anonymous. Omit to hide. */
	loginHref?: string
	/** Called after the sign-out trigger (host signs out + navigates). */
	onSignOut?: () => void
}

/** Type guard: link entry (has `href`, no `component`). */
export function isMenuLink(item: NavItem): item is MenuLinkItem {
	return item.kind === 'link'
}

/** Type guard: flyout-slot entry (has `component`). */
export function isMenuSlot(item: NavItem): item is MenuSlotItem {
	return item.kind === 'slot'
}
