<script lang="ts">
	import type { Snippet } from 'svelte'
	import type { WorkflowInputField } from './define.js'
	import type { WorkflowInteractionLite } from './display.js'
	import type { WorkflowStreamEvent } from './types.js'
	import WorkflowInputForm from './WorkflowInputForm.svelte'
	import WorkflowOutput from './WorkflowOutput.svelte'
	import WorkflowStream from './WorkflowStream.svelte'

	/**
	 * Workflow pane orchestrator (plan `plans/workflow-ui.md` §2.4).
	 *
	 * Mirrors `ChatPane.svelte`: `starting` (input form) → `running`
	 * (stream + cancel + pinned ask-human slot) → terminal
	 * (`done`/`error`/`cancelled` → output + follow-up slot).
	 *
	 * Transport-agnostic: the host owns fetching (start POST, stream
	 * poll/SSE, cancel POST, answer POST) and passes state down; this
	 * component only renders + forwards callbacks. Ask-human cards render
	 * through the `askHuman` snippet (pinned at the bottom while open);
	 * the follow-up chat entry renders through the `followUp` snippet.
	 */
	let {
		phase = 'starting',
		fields = [],
		events = [],
		interactions = [],
		output = null,
		inputLabels = {},
		defLabels = {},
		outputLabels = {},
		submitLabel = 'Start workflow',
		cancelLabel = 'Cancel',
		toolIcons = {},
		streamLabels = {},
		onstart = null,
		oncancel = null,
		askHuman = null,
		followUp = null
	}: {
		phase?: 'starting' | 'running' | 'done' | 'error' | 'cancelled'
		fields?: WorkflowInputField[]
		events?: WorkflowStreamEvent[]
		interactions?: WorkflowInteractionLite[]
		output?: unknown
		inputLabels?: Record<string, string>
		defLabels?: Record<string, string>
		outputLabels?: Record<string, string>
		submitLabel?: string
		cancelLabel?: string
		toolIcons?: Record<string, string>
		streamLabels?: Partial<{
			running: string
			waiting: string
			done: string
			error: string
			cancelled: string
			stale: string
		}>
		onstart?: ((input: Record<string, unknown>) => Promise<void> | void) | null
		oncancel?: (() => Promise<void> | void) | null
		/** Pinned ask-human slot (open questions render at the bottom). */
		askHuman?: Snippet | null
		/** Follow-up chat entry (rendered below the output when done). */
		followUp?: Snippet | null
	} = $props()

	let cancelling = $state(false)
	let cancelError = $state<string | null>(null)

	async function cancel(): Promise<void> {
		if (cancelling || !oncancel) return
		cancelling = true
		cancelError = null
		try {
			await oncancel()
		} catch (err) {
			cancelError = err instanceof Error ? err.message : String(err)
		} finally {
			cancelling = false
		}
	}
</script>

<div class="workflow-pane" data-testid="workflow-pane" data-phase={phase}>
	{#if phase === 'starting'}
		<WorkflowInputForm {fields} {inputLabels} {submitLabel} onsubmit={onstart} />
	{:else}
		<WorkflowStream {events} {interactions} {toolIcons} labels={streamLabels}>
			{#if phase === 'running' && askHuman}
				<div data-testid="workflow-ask-human-pinned">
					{@render askHuman()}
				</div>
			{/if}
		</WorkflowStream>
		{#if phase === 'running' && oncancel}
			<div class="workflow-pane-actions">
				<button
					type="button"
					data-testid="workflow-cancel"
					disabled={cancelling}
					onclick={() => void cancel()}
				>
					{cancelling ? 'Cancelling…' : cancelLabel}
				</button>
				{#if cancelError}
					<p role="alert" data-testid="workflow-cancel-error">{cancelError}</p>
				{/if}
			</div>
		{/if}
		{#if phase === 'done' || phase === 'error' || phase === 'cancelled'}
			{#if output === null || output === undefined}
				<p data-testid="workflow-output-empty" class="workflow-output-empty">
					{phase === 'done' ? 'Done — no output.' : phase === 'cancelled' ? 'Cancelled.' : 'Error.'}
				</p>
			{:else}
				<WorkflowOutput {output} {defLabels} {outputLabels} />
			{/if}
		{/if}
		{#if phase === 'done' && followUp}
			<div data-testid="workflow-follow-up">
				{@render followUp()}
			</div>
		{/if}
	{/if}
</div>

<style>
	.workflow-pane {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}
	.workflow-pane-actions {
		display: flex;
		gap: 0.5rem;
		align-items: baseline;
	}
	.workflow-output-empty {
		font-size: 0.875rem;
		opacity: 0.75;
		margin: 0;
	}
</style>
