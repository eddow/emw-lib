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

/** Per-page tool rendered next to the gear (e.g. emw's CV PDF save link). */
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

/** Type guard: link entry (has `href`, no `component`). */
export function isMenuLink(item: NavItem): item is MenuLinkItem {
	return item.kind === 'link'
}

/** Type guard: flyout-slot entry (has `component`). */
export function isMenuSlot(item: NavItem): item is MenuSlotItem {
	return item.kind === 'slot'
}
