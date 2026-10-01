<script lang="ts">
	import type { ChatMessage } from './transcript.js'

	/**
	 * Thought row: reasoning rendered like a tool call (plan
	 * `plans/ChatOutput.md` §1.0–1.1).
	 *
	 * - Live (`pending`, streaming draft): expanded block, `max-height`
	 *   ~6 lines, `overflow-y: auto`, showing the reasoning as it streams.
	 * - Settled (durable `thought` event): collapsed one-liner
	 *   `💭 Thoughts` (translated via `labels`), expandable via `<details>`
	 *   for the full text.
	 * - Icon defaults to 💭, overridable via `icon`.
	 */
	let {
		msg,
		icon = '💭',
		labels = {}
	}: {
		msg: ChatMessage & { kind: 'thought' }
		icon?: string
		/**
		 * Translated UI strings. Paraglide lives in the host — pass
		 * `m.*()` strings here; English defaults apply otherwise.
		 */
		labels?: Partial<{ thoughts: string }>
	} = $props()

	const title = $derived(labels.thoughts ?? 'Thoughts')
</script>

<div
	class="alfred-thought"
	class:alfred-thought-pending={msg.pending}
	data-testid="alfred-thought-row"
	data-pending={msg.pending}
>
	{#if msg.pending}
		<div class="alfred-thought-live" data-testid="alfred-thought-live">
			<span aria-hidden="true">{icon}</span>
			<span data-testid="alfred-thought-summary">{title}</span>
			<pre class="alfred-thought-text">{msg.text}</pre>
		</div>
	{:else}
		<details class="alfred-thought-settled" data-testid="alfred-thought-settled">
			<summary>
				<span aria-hidden="true">{icon}</span>
				<span data-testid="alfred-thought-summary">{title}</span>
			</summary>
			<pre class="alfred-thought-text">{msg.text}</pre>
		</details>
	{/if}
</div>

<style>
	.alfred-thought {
		align-self: center;
		width: 100%;
		opacity: 0.75;
		font-style: italic;
	}
	.alfred-thought-live {
		max-height: 9rem;
		overflow-y: auto;
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}
	.alfred-thought-text {
		white-space: pre-wrap;
		word-break: break-word;
		max-height: 9rem;
		overflow-y: auto;
		margin: 0;
	}
	.alfred-thought-settled .alfred-thought-text {
		max-height: 12rem;
	}
</style>
