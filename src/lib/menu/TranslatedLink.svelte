<!--
 * Per-locale link helper for host-owned menu flyout slots.
 *
 * Renders a single anchor whose `href` follows the active locale:
 *
 * ```svelte
 * <TranslatedLink
 *   hrefs={{ en: '/turnkey', fr: '/cle-en-main', ro: '/la-cheie' }}
 *   locale="fr"
 *   label="Turnkey"
 * />
 * ```
 *
 * Used inside `AppMenu` slot components (e.g. emw's translated model slugs)
 * where the lib must stay navigation-agnostic: the host pre-resolves every
 * locale's URL and only the active one is rendered.
 -->

<script lang="ts">
	let {
		hrefs,
		locale,
		label,
		icon = null,
		title = undefined,
		target = undefined,
		rel = undefined,
		active = false
	}: {
		/** Per-locale destinations, keyed by locale code. */
		hrefs: Record<string, string>
		/** Active locale code. */
		locale: string
		/** Accessible label. */
		label: string
		/** Optional emoji/glyph prefix. */
		icon?: string | null
		/** Tooltip override. Defaults to `label`. */
		title?: string
		/** Link target. */
		target?: string
		/** Link rel. */
		rel?: string
		/** Marks the link active (`aria-current="page"`). */
		active?: boolean
	} = $props()

	const fallback = $derived(Object.values(hrefs)[0] ?? '/')
	const href = $derived(hrefs[locale] ?? fallback)
</script>

<a
	{href}
	aria-label={label}
	title={title ?? label}
	{target}
	{rel}
	aria-current={active ? 'page' : undefined}
>
	{#if icon}<span aria-hidden="true">{icon}</span>
	{/if}{label}
</a>
