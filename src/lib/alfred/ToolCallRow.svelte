<script lang="ts">
	import type { ChatMessage } from './transcript.js'

	/**
	 * One-line tool-call row with an icon + `<details>` for args/output
	 * (plan `plans/ChatOutput.md` §1.0–1.1).
	 *
	 * - Settled (paired `tool_use`→`tool_result`): collapsed one-liner
	 *   `🔧 name — summary`, expandable for full args/output.
	 * - Live (unpaired `tool_use`, `pending`): expanded block, `max-height`
	 *   ~12 lines, `overflow-y: auto`, showing progression as it occurs.
	 * - Icon: one per tool via `icons` (default 🔧 wrench).
	 */
	let {
		msg,
		icons = {},
		labels = {}
	}: {
		msg: ChatMessage & { kind: 'tool_call'; tool: NonNullable<ChatMessage['tool']> }
		icons?: Record<string, string>
		/**
		 * Translated UI strings. Paraglide lives in the host — pass
		 * `m.*()` strings here; English defaults apply otherwise.
		 */
		labels?: Partial<{ arguments: string; output: string }>
	} = $props()

	const icon = $derived(icons[msg.tool.toolName] ?? '🔧')
</script>

<div
	class="alfred-tool-call"
	class:alfred-tool-pending={msg.tool.pending}
	data-testid="alfred-tool-call"
	data-tool={msg.tool.toolName}
	data-pending={msg.tool.pending}
>
	{#if msg.tool.pending}
		<div class="alfred-tool-live" data-testid="alfred-tool-live">
			<span aria-hidden="true">{icon}</span>
			<span data-testid="alfred-tool-summary">{msg.text}</span>
			{#if msg.tool.argsText}
				<pre class="alfred-tool-args">{msg.tool.argsText}</pre>
			{/if}
		</div>
	{:else}
		<details class="alfred-tool-settled" data-testid="alfred-tool-settled">
			<summary>
				<span aria-hidden="true">{icon}</span>
				<span data-testid="alfred-tool-summary">{msg.text}</span>
			</summary>
			{#if msg.tool.argsText}
				<div class="alfred-tool-section">
					<strong>{labels.arguments ?? 'Arguments'}</strong>
					<pre>{msg.tool.argsText}</pre>
				</div>
			{/if}
			{#if msg.tool.outputText}
				<div class="alfred-tool-section">
					<strong>{labels.output ?? 'Output'}</strong>
					<pre>{msg.tool.outputText}</pre>
				</div>
			{/if}
		</details>
	{/if}
</div>

<style>
	.alfred-tool-call {
		align-self: center;
		width: 100%;
		opacity: 0.85;
	}
	.alfred-tool-live {
		max-height: 12rem;
		overflow-y: auto;
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}
	.alfred-tool-live pre,
	.alfred-tool-settled pre {
		white-space: pre-wrap;
		word-break: break-word;
		max-height: 12rem;
		overflow-y: auto;
	}
</style>
