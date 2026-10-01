<script lang="ts">
	import type { Snippet } from 'svelte'
	import { renderMarkdown } from '../alfred/markdown.js'
	import { normalizeWorkflowOutput } from './display.js'

	/**
	 * Generic workflow output screen (plan `plans/workflow-ui.md` §2.3).
	 *
	 * Default: a well-formed `<dl>` — `<dt>` = label, `<dd>` = value
	 * (strings via the shared `renderMarkdown`, anything else via
	 * `JSON.stringify`). A custom `children` snippet replaces the `<dl>`.
	 * Scalar/array W-O wraps as `{ result }` (see `normalizeWorkflowOutput`).
	 */
	let {
		output,
		defLabels = {},
		outputLabels = {},
		children = null
	}: {
		output: unknown
		/** Def-level `outputLabels` (English defaults from the workflow meta). */
		defLabels?: Record<string, string>
		/** App-level labels (paraglide `m.*()`, merged over `defLabels`). */
		outputLabels?: Record<string, string>
		/** App override: replaces the default `<dl>`. */
		children?: Snippet | null
	} = $props()

	const entries = $derived(normalizeWorkflowOutput(output, { defLabels, appLabels: outputLabels }))

	function isString(value: unknown): value is string {
		return typeof value === 'string'
	}
</script>

{#if children}
	{@render children()}
{:else}
	<dl data-testid="workflow-output" class="workflow-output">
		{#each entries as e (e.key)}
			<div class="workflow-output-row" data-testid="workflow-output-row" data-key={e.key}>
				<dt class="workflow-output-key">{e.title}</dt>
				<dd class="workflow-output-value">
					{#if isString(e.value)}
						{@html renderMarkdown(e.value)}
					{:else}
						<pre data-testid="workflow-output-json">{JSON.stringify(e.value, null, 2)}</pre>
					{/if}
				</dd>
			</div>
		{/each}
	</dl>
{/if}

<style>
	.workflow-output {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		margin: 0;
	}
	.workflow-output-row {
		display: grid;
		grid-template-columns: minmax(8rem, 12rem) 1fr;
		gap: 0.5rem 1rem;
		align-items: baseline;
	}
	.workflow-output-key {
		font-weight: 600;
		font-size: 0.8125rem;
		color: var(--muted-foreground, #555);
	}
	.workflow-output-value {
		margin: 0;
		font-size: 0.875rem;
		min-width: 0;
		overflow-wrap: anywhere;
	}
	@media (max-width: 40rem) {
		.workflow-output-row {
			grid-template-columns: 1fr;
		}
	}
</style>
