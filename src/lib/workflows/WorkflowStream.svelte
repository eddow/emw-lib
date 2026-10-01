<script lang="ts">
	import type { Snippet } from 'svelte'
	import type { WorkflowInteractionLite } from './display.js'
	import { groupParallelOpens } from './display.js'
	import type { WorkflowStreamEvent } from './types.js'

	/**
	 * Chat-like live view over workflow stream events
	 * (plan `plans/workflow-ui.md` §2.2).
	 *
	 * One row per `interaction_opened` (text = `label_text` verbatim —
	 * `label` is the future i18n key, never rendered). Consecutive idxs
	 * (fan-out batches) render in one responsive grid line (single column
	 * on mobile, no horizontal scroll). `interaction_resolved` flips the
	 * row to settled; `log` renders dimmed; `version_stale` is a warning
	 * banner (the run continues); `run_status` drives the header state.
	 */
	let {
		events = [],
		interactions = [],
		toolIcons = {},
		labels = {},
		children = null
	}: {
		events?: WorkflowStreamEvent[]
		interactions?: WorkflowInteractionLite[]
		/** Per-tool icons (default 🔧; session 🗂️, prompt 💭). */
		toolIcons?: Record<string, string>
		/**
		 * Translated UI strings. Paraglide lives in the host — pass
		 * `m.*()` strings here; English defaults apply otherwise.
		 */
		labels?: Partial<{
			running: string
			waiting: string
			done: string
			error: string
			cancelled: string
			stale: string
		}>
		/** App override slot rendered after the stream (e.g. pinned ask-human). */
		children?: Snippet | null
	} = $props()

	interface Row {
		idx: number
		icon: string
		text: string
		status: WorkflowInteractionLite['status']
	}

	const byIdx = $derived(new Map(interactions.map((i) => [i.idx, i] as const)))

	const opened = $derived(
		events.filter((e) => e.type === 'interaction_opened') as Extract<
			WorkflowStreamEvent,
			{ type: 'interaction_opened' }
		>[]
	)

	const resolvedByIdx = $derived(
		(() => {
			const map = new Map<number, string>()
			for (const e of events) {
				if (e.type === 'interaction_resolved') map.set(e.idx, e.status)
			}
			return map
		})()
	)

	function iconFor(kind: string, tool?: string | null): string {
		if (tool && toolIcons[tool]) return toolIcons[tool] as string
		if (kind === 'session') return '🗂️'
		if (kind === 'prompt') return '💭'
		return '🔧'
	}

	const rows: Row[] = $derived(
		opened.map((e) => {
			const lite = byIdx.get(e.idx)
			const resolved = resolvedByIdx.get(e.idx)
			return {
				idx: e.idx,
				icon: iconFor(e.kind, e.tool),
				text: e.label_text,
				status: (resolved as Row['status'] | undefined) ?? lite?.status ?? 'open'
			}
		})
	)

	const groups: Row[][] = $derived(
		(() => {
			const order = rows.map((r) => r.idx)
			const grouped = groupParallelOpens(order)
			const byId = new Map(rows.map((r) => [r.idx, r] as const))
			return grouped.map((g) => g.map((idx) => byId.get(idx)!) as Row[])
		})()
	)

	const logs = $derived(
		events.filter((e) => e.type === 'log') as Extract<WorkflowStreamEvent, { type: 'log' }>[]
	)

	const stale = $derived(
		events.filter((e) => e.type === 'version_stale') as Extract<
			WorkflowStreamEvent,
			{ type: 'version_stale' }
		>[]
	)

	const status = $derived(
		(() => {
			for (let i = events.length - 1; i >= 0; i--) {
				const e = events[i]
				if (e?.type === 'run_status') return e.status
			}
			return 'running' as const
		})()
	)

	const statusText = $derived(
		status === 'running'
			? (labels.running ?? 'Running…')
			: status === 'waiting'
				? (labels.waiting ?? 'Waiting…')
				: status === 'done'
					? (labels.done ?? 'Done')
					: status === 'cancelled'
						? (labels.cancelled ?? 'Cancelled')
						: (labels.error ?? 'Error')
	)
</script>

<div class="workflow-stream" data-testid="workflow-stream" data-status={status}>
	<p class="workflow-stream-status" data-testid="workflow-stream-status" role="status">
		{statusText}
	</p>
	{#if stale.length > 0}
		<p class="workflow-stream-stale" data-testid="workflow-stream-stale" role="alert">
			{labels.stale ?? 'This run continues on a stale deployment.'}
		</p>
	{/if}
	<div class="workflow-stream-rows" data-testid="workflow-stream-rows">
		{#each groups as group, gi (gi)}
			<div
				class="workflow-stream-line"
				class:workflow-stream-line-parallel={group.length > 1}
				data-testid="workflow-stream-line"
				data-parallel={group.length > 1}
			>
				{#each group as row (row.idx)}
					<div
						class="workflow-stream-row"
						class:workflow-stream-open={row.status === 'open'}
						data-testid="workflow-stream-row"
						data-idx={row.idx}
						data-status={row.status}
					>
						<span aria-hidden="true">{row.icon}</span>
						<span data-testid="workflow-stream-text">{row.text}</span>
					</div>
				{/each}
			</div>
		{/each}
	</div>
	{#if logs.length > 0}
		<div class="workflow-stream-logs" data-testid="workflow-stream-logs">
			{#each logs as l (`${l.tick}:${l.seq}`)}
				<p class="workflow-stream-log" data-testid="workflow-stream-log">{l.message}</p>
			{/each}
		</div>
	{/if}
	{#if children}
		{@render children()}
	{/if}
</div>

<style>
	.workflow-stream {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
	.workflow-stream-status {
		font-size: 0.8125rem;
		opacity: 0.75;
		margin: 0;
	}
	.workflow-stream-stale {
		font-size: 0.8125rem;
		color: var(--warning, #92600a);
		margin: 0;
	}
	.workflow-stream-rows {
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
	}
	.workflow-stream-line {
		display: grid;
		gap: 0.375rem;
		grid-template-columns: 1fr;
	}
	.workflow-stream-line-parallel {
		grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr));
	}
	@media (min-width: 48rem) {
		.workflow-stream-line-parallel {
			grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr));
			max-width: 100%;
		}
	}
	.workflow-stream-row {
		border: 1px solid var(--border, #ddd);
		border-radius: 0.375rem;
		padding: 0.375rem 0.625rem;
		font-size: 0.875rem;
		display: flex;
		gap: 0.375rem;
		align-items: baseline;
		min-width: 0;
	}
	.workflow-stream-open {
		border-style: dashed;
	}
	.workflow-stream-logs {
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
	}
	.workflow-stream-log {
		font-size: 0.75rem;
		opacity: 0.6;
		margin: 0;
	}
</style>
