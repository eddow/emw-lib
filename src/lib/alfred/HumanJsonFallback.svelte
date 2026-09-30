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
		onanswer = null
	}: {
		toolCallId: string
		answered?: unknown
		onanswer?: ((value: unknown) => Promise<void> | void) | null
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
			error = 'invalid JSON'
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
			bind:value={raw}
			rows={3}
			aria-label="Answer as JSON"
		></textarea>
		<button
			type="button"
			data-testid="alfred-human-json-submit"
			disabled={sending}
			onclick={() => void submit()}
		>
			{sending ? 'Answering…' : 'Answer'}
		</button>
	{/if}
	{#if error}
		<p data-testid="alfred-human-json-error" role="alert">{error}</p>
	{/if}
</div>
