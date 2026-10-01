<script lang="ts">
	import type { ChatMessage } from './transcript.js'

	/**
	 * One-line terminal status for `done/superseded|archived`
	 * (plan `plans/ChatOutput.md` §1.2). No retry button — informational only.
	 * The host passes translated labels via `labels` (paraglide lives in the
	 * app, never in `emw-lib`); English defaults keep the lib usable standalone.
	 */
	let {
		msg,
		labels = {}
	}: {
		msg: ChatMessage & { kind: 'status'; status: NonNullable<ChatMessage['status']> }
		labels?: Partial<Record<'superseded' | 'archived', string>>
	} = $props()

	const text = $derived(
		labels[msg.status.reason] ??
			(msg.status.reason === 'superseded' ? 'Superseded by a newer generation' : 'Session archived')
	)
</script>

<p
	class="alfred-status-line"
	data-testid="alfred-status-line"
	data-reason={msg.status.reason}
	role="status"
>
	<span aria-hidden="true">ℹ️</span>
	{text}
</p>

<style>
	.alfred-status-line {
		align-self: center;
		opacity: 0.75;
		display: flex;
		gap: 0.375rem;
		align-items: baseline;
	}
</style>
