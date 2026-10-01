<script lang="ts">
	import type { Snippet } from 'svelte'
	import type { WorkflowInputField } from './define.js'

	/**
	 * Generic workflow input form (plan `plans/workflow-ui.md` §2.1).
	 *
	 * Renders one `<input name={field.name}>` (or textarea / select /
	 * checkbox / multi-line for `urls`) per field. Submits a plain object
	 * `{ [name]: value }` via `onsubmit` — a custom `children` snippet
	 * replaces the default fields but still submits through the same
	 * `FormData` collection, so the host route stays snippet-agnostic.
	 *
	 * Paraglide lives in the host: labels/placeholders arrive via
	 * `inputLabels` / field `placeholder`; English defaults apply otherwise.
	 */
	let {
		fields = [],
		inputLabels = {},
		submitLabel = 'Start workflow',
		children = null,
		onsubmit = null
	}: {
		fields?: WorkflowInputField[]
		inputLabels?: Record<string, string>
		submitLabel?: string
		/** App override: replaces the default fields (still inside the `<form>`). */
		children?: Snippet | null
		/** Called with the collected `{ [name]: value }` object. */
		onsubmit?: ((input: Record<string, unknown>) => Promise<void> | void) | null
	} = $props()

	let formEl = $state<HTMLFormElement | null>(null)
	let error = $state<string | null>(null)
	let submitting = $state(false)

	function labelFor(field: WorkflowInputField): string {
		return inputLabels[field.name] ?? field.placeholder ?? field.name
	}

	async function handleSubmit(e: SubmitEvent): Promise<void> {
		e.preventDefault()
		if (!formEl || submitting) return
		const fd = new FormData(formEl)
		const out: Record<string, unknown> = {}
		for (const f of fields) {
			const raw = fd.get(f.name)
			if (f.type === 'boolean') {
				out[f.name] = raw !== null
			} else if (f.type === 'number') {
				if (raw === null || String(raw).trim() === '') out[f.name] = ''
				else {
					const n = Number(raw)
					// NaN never survives JSON to the starter — surface it as
					// empty so `required` catches it instead of sending `null`.
					out[f.name] = Number.isNaN(n) ? '' : n
				}
			} else if (f.type === 'urls') {
				out[f.name] = String(raw ?? '')
					.split('\n')
					.map((s) => s.trim())
					.filter(Boolean)
			} else {
				out[f.name] = raw === null ? '' : String(raw)
			}
		}
		for (const f of fields) {
			if (!f.required) continue
			const v = out[f.name]
			if (v === '' || v === null || (Array.isArray(v) && v.length === 0)) {
				error = `${labelFor(f)} is required`
				return
			}
		}
		error = null
		submitting = true
		try {
			await onsubmit?.(out)
		} catch (err) {
			error = err instanceof Error ? err.message : String(err)
		} finally {
			submitting = false
		}
	}
</script>

<form
	bind:this={formEl}
	onsubmit={handleSubmit}
	novalidate
	data-testid="workflow-input-form"
	class="workflow-input-form"
>
	{#if children}
		{@render children()}
	{:else}
		{#each fields as f (f.name)}
			<label class="workflow-input-field" data-testid="workflow-input-field-{f.name}">
				<span class="workflow-input-label">{labelFor(f)}</span>
				{#if f.type === 'textarea' || f.type === 'urls'}
					<textarea
						name={f.name}
						required={f.required}
						placeholder={f.type === 'urls' ? 'one per line' : (f.placeholder ?? '')}
						rows={f.type === 'urls' ? 4 : 3}
						class="workflow-input-control"
						>{typeof f.defaultValue === 'string'
							? f.defaultValue
							: Array.isArray(f.defaultValue)
								? f.defaultValue.join('\n')
								: ''}</textarea
					>
				{:else if f.type === 'select'}
					<select name={f.name} required={f.required} class="workflow-input-control">
						{#if f.defaultValue === undefined}
							<option value="" selected disabled>—</option>
						{/if}
						{#each f.options ?? [] as opt (opt)}
							<option value={opt} selected={f.defaultValue === opt}>{opt}</option>
						{/each}
					</select>
				{:else if f.type === 'boolean'}
					<input
						type="checkbox"
						name={f.name}
						checked={f.defaultValue === true}
						class="workflow-input-control"
					/>
				{:else if f.type === 'number'}
					<input
						type="number"
						name={f.name}
						required={f.required}
						placeholder={f.placeholder ?? ''}
						value={typeof f.defaultValue === 'number' ? f.defaultValue : ''}
						class="workflow-input-control"
					/>
				{:else}
					<input
						type="text"
						name={f.name}
						required={f.required}
						placeholder={f.placeholder ?? ''}
						value={typeof f.defaultValue === 'string' ? f.defaultValue : ''}
						class="workflow-input-control"
					/>
				{/if}
			</label>
		{/each}
	{/if}
	{#if error}
		<p role="alert" data-testid="workflow-input-error" class="workflow-input-error">{error}</p>
	{/if}
	<button
		type="submit"
		disabled={submitting}
		data-testid="workflow-input-submit"
		class="workflow-input-submit"
	>
		{submitting ? 'Starting…' : submitLabel}
	</button>
</form>

<style>
	.workflow-input-form {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}
	.workflow-input-field {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}
	.workflow-input-label {
		font-size: 0.75rem;
		color: var(--muted-foreground, #666);
	}
	.workflow-input-control {
		border: 1px solid var(--border, #ddd);
		border-radius: 0.375rem;
		padding: 0.375rem 0.625rem;
		font-size: 0.875rem;
		background: var(--background, #fff);
		color: var(--foreground, inherit);
	}
	.workflow-input-error {
		font-size: 0.8125rem;
		color: var(--destructive, #b00);
	}
	.workflow-input-submit {
		align-self: flex-start;
	}
</style>
