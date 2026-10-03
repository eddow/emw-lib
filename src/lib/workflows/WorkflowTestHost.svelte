<script lang="ts">
	import WorkflowInputForm from './WorkflowInputForm.svelte'
	import WorkflowOutput from './WorkflowOutput.svelte'
	import WorkflowPane from './WorkflowPane.svelte'
	import WorkflowStream from './WorkflowStream.svelte'
	import type { WorkflowInputField } from './define.js'
	import type { WorkflowInteractionLite } from './display.js'
	import type { WorkflowStreamEvent } from './types.js'

	let {
		fields = [],
		events = [],
		interactions = [],
		output = null,
		phase = 'starting',
		only = 'stream',
		onsubmit = null,
		oncancel = null,
		onstart = null,
		inputLabels = {},
		optionLabels = {},
		defLabels = {},
		outputLabels = {},
		submitLabel = 'Start workflow',
		cancelLabel = 'Cancel',
		toolIcons = {},
		streamLabels = {},
		ticking = false,
		drafts = {},
		formLabels = {},
		paneLabels = {},
		showAskHuman = false,
		showFollowUp = false,
		customForm = false,
		customOutput = false
	}: {
		fields?: WorkflowInputField[]
		events?: WorkflowStreamEvent[]
		interactions?: WorkflowInteractionLite[]
		output?: unknown
		phase?: 'starting' | 'running' | 'done' | 'error' | 'cancelled'
		only?: 'form' | 'output' | 'pane' | 'stream'
		onsubmit?: ((input: Record<string, unknown>) => Promise<void> | void) | null
		oncancel?: (() => Promise<void> | void) | null
		onstart?: ((input: Record<string, unknown>) => Promise<void> | void) | null
		inputLabels?: Record<string, string>
		optionLabels?: Record<string, string>
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
			working: string
		}>
		ticking?: boolean
		drafts?: Record<number, string>
		formLabels?: Partial<{
			starting: string
			urlsPlaceholder: string
			required: (label: string) => string
		}>
		paneLabels?: Partial<{
			cancelling: string
			doneEmpty: string
			cancelledEmpty: string
			errorEmpty: string
		}>
		showAskHuman?: boolean
		showFollowUp?: boolean
		customForm?: boolean
		customOutput?: boolean
	} = $props()
</script>

{#snippet askHumanSnippet()}
	<p data-testid="workflow-ask-human">Need your input</p>
{/snippet}

{#snippet followUpSnippet()}
	<p data-testid="workflow-follow-up-chat">Follow-up chat</p>
{/snippet}

{#snippet customFormSnippet()}
	<!-- Same field name as the default form: the override replaces the
		rendered controls but submits through the same FormData collection. -->
	<input name="productDescription" value="hello-custom" data-testid="workflow-input-custom" />
{/snippet}

{#snippet customOutputSnippet()}
	<p data-testid="workflow-output-custom">Custom output</p>
{/snippet}

{#if only === 'form'}
	{#if customForm}
		<WorkflowInputForm
			{fields}
			{inputLabels}
			{optionLabels}
			{submitLabel}
			labels={formLabels}
			{onsubmit}
		>
			{#snippet children()}
				{@render customFormSnippet()}
			{/snippet}
		</WorkflowInputForm>
	{:else}
		<WorkflowInputForm
			{fields}
			{inputLabels}
			{optionLabels}
			{submitLabel}
			labels={formLabels}
			{onsubmit}
		/>
	{/if}
{:else if only === 'output'}
	{#if customOutput}
		<WorkflowOutput {output} {defLabels} {outputLabels}>
			{#snippet children()}
				{@render customOutputSnippet()}
			{/snippet}
		</WorkflowOutput>
	{:else}
		<WorkflowOutput {output} {defLabels} {outputLabels} />
	{/if}
{:else if only === 'pane'}
	<WorkflowPane
		{fields}
		{events}
		{interactions}
		{output}
		{phase}
		{inputLabels}
		{optionLabels}
		{defLabels}
		{outputLabels}
		{submitLabel}
		{cancelLabel}
		{toolIcons}
		{streamLabels}
		{ticking}
		{drafts}
		{formLabels}
		{paneLabels}
		{onstart}
		{oncancel}
		askHuman={showAskHuman ? askHumanSnippet : null}
		followUp={showFollowUp ? followUpSnippet : null}
	/>
{:else}
	<WorkflowStream {events} {interactions} {toolIcons} {ticking} {drafts} labels={streamLabels} />
{/if}
