<script lang="ts">
	/**
	 * JSON fallback renderer for human tools with no registered component
	 * (butler §9). A textarea holding a JSON value plus a submit button;
	 * the parent posts it via `AlfredClient.answerHuman`. Disabled once
	 * answered (history replay / receipt).
	 */
	let {
		toolCallId,
		answered = null,
		onanswer = null,
		labels = {}
	}: {
		toolCallId: string
		answered?: unknown
		onanswer?: ((value: unknown) => Promise<void> | void) | null
		/**
		 * Translated UI strings. Paraglide lives in the host — pass
		 * `m.*()` strings here; English defaults apply otherwise.
		 */
		labels?: Partial<{
			answerAsJson: string
			answer: string
			answering: string
			invalidJson: string
		}>
	} = $props()

	let raw = $state('{}')
	let sending = $state(false)
	let error = $state<string | null>(null)
	const disabled = $derived(answered !== null && answered !== undefined)

	async function submit(): Promise<void> {
		if (disabled || sending || !onanswer) return
		let value: unknown
		try {
			value = JSON.parse(raw)
		} catch {
			error = labels.invalidJson ?? 'invalid JSON'
			return
		}
		sending = true
		error = null
		try {
			await onanswer(value)
		} catch (err) {
			error = err instanceof Error ? err.message : String(err)
		} finally {
			sending = false
		}
	}
</script>

<div class="alfred-human-json" data-testid="alfred-human-json" data-tool-call={toolCallId}>
	{#if disabled}
		<pre data-testid="alfred-human-json-receipt">{JSON.stringify(answered)}</pre>
	{:else}
		<textarea
			data-testid="alfred-human-json-input"
			class="alfred-human-json-input"
			bind:value={raw}
			rows={3}
			aria-label={labels.answerAsJson ?? 'Answer as JSON'}
		></textarea>
		<button
			type="button"
			data-testid="alfred-human-json-submit"
			disabled={sending}
			onclick={() => void submit()}
		>
			{sending ? (labels.answering ?? 'Answering…') : (labels.answer ?? 'Answer')}
		</button>
	{/if}
	{#if error}
		<p data-testid="alfred-human-json-error" role="alert">{error}</p>
	{/if}
</div>

<style>
	/* Theme-aware (never the forms-plugin white) — same `--alfred-*`
	 * tokens as `Chat` (this renders inside `.alfred-chat`). */
	.alfred-human-json-input {
		border: 1px solid var(--alfred-input, var(--input, oklch(0.922 0 0)));
		border-radius: calc(var(--alfred-radius, 0.625rem) - 2px);
		background: var(--alfred-bg, var(--card, oklch(1 0 0)));
		color: var(--alfred-fg, var(--card-foreground, inherit));
		padding: 0.375rem 0.625rem;
		font-size: 0.875rem;
		font-family: inherit;
		resize: vertical;
		outline: none;
		width: 100%;
		box-sizing: border-box;
	}
	.alfred-human-json-input:focus-visible {
		border-color: var(--alfred-ring, var(--ring, oklch(0.708 0 0)));
		box-shadow: 0 0 0 3px
			color-mix(in oklch, var(--alfred-ring, var(--ring, oklch(0.708 0 0))) 50%, transparent);
	}
</style>
