<script lang="ts">
	import { onMount } from 'svelte'
	import type { ChatMessage } from './transcript.js'

	/**
	 * Expandable retry box for terminal `done/max_iterations` + `error`
	 * (plan `plans/ChatOutput.md` §1.2).
	 *
	 * - Collapsed one-liner + `<details>` for the full error text.
	 * - **Keep / Try again** button: dismisses the box, then delegates to
	 *   `onretry` (the host resumes / re-prompts via its stream route).
	 * - Rate-limit-style errors (`retryAfterS` present) show a 🐌 countdown
	 *   and auto-retry when it reaches zero. No blind auto-retry otherwise.
	 */
	let {
		msg,
		onretry = null,
		labels = {}
	}: {
		msg: ChatMessage & { kind: 'retry'; retry: NonNullable<ChatMessage['retry']> }
		onretry?: ((msgId: string) => Promise<void> | void) | null
		/**
		 * Translated UI strings. Paraglide lives in the host — pass
		 * `m.*()` strings here; English defaults apply otherwise.
		 * `retryingIn` receives the remaining seconds.
		 */
		labels?: Partial<{
			details: string
			retrying: string
			keepRetry: string
			dismiss: string
			retryingIn: (seconds: number) => string
		}>
	} = $props()

	let dismissed = $state(false)
	// svelte-ignore state_referenced_locally: construction-time config, one message per box instance.
	let remaining = $state(msg.retry.retryAfterS ?? 0)
	let retrying = $state(false)

	const isRateLimit = $derived(msg.retry.retryAfterS !== undefined)

	$effect(() => {
		if (!isRateLimit || dismissed) return
		if (remaining <= 0) {
			void handleRetry(true)
			return
		}
		const t = setTimeout(() => {
			remaining -= 1
		}, 1000)
		return () => clearTimeout(t)
	})

	onMount(() => {
		remaining = msg.retry.retryAfterS ?? 0
	})

	async function handleRetry(_auto = false): Promise<void> {
		if (dismissed || retrying) return
		retrying = true
		try {
			dismissed = true
			await onretry?.(msg.id)
		} finally {
			retrying = false
		}
	}

	function dismiss(): void {
		dismissed = true
	}
</script>

{#if !dismissed}
	<div
		class="alfred-retry"
		class:alfred-retry-ratelimit={isRateLimit}
		data-testid="alfred-retry-box"
		data-reason={msg.retry.reason}
		role="alert"
	>
		<div class="alfred-retry-line">
			<span aria-hidden="true">{isRateLimit ? '🐌' : '⚠️'}</span>
			<span data-testid="alfred-retry-summary">{msg.text}</span>
			{#if isRateLimit && remaining > 0}
				<span data-testid="alfred-retry-countdown"
					>{labels.retryingIn?.(remaining) ?? `retrying in ${remaining}s…`}</span
				>
			{/if}
		</div>
		<details class="alfred-retry-detail" data-testid="alfred-retry-detail">
			<summary>{labels.details ?? 'Details'}</summary>
			<pre>{msg.retry.errorText}</pre>
		</details>
		<div class="alfred-retry-actions">
			<button
				type="button"
				data-testid="alfred-retry-button"
				disabled={retrying}
				onclick={() => void handleRetry(false)}
			>
				{retrying ? (labels.retrying ?? 'Retrying…') : (labels.keepRetry ?? 'Keep / Try again')}
			</button>
			<button type="button" data-testid="alfred-retry-dismiss" onclick={dismiss}
				>{labels.dismiss ?? 'Dismiss'}</button
			>
		</div>
	</div>
{/if}

<style>
	.alfred-retry {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		border: 1px solid currentColor;
		border-radius: 0.375rem;
		padding: 0.375rem 0.5rem;
	}
	.alfred-retry-line {
		display: flex;
		align-items: baseline;
		gap: 0.375rem;
	}
	.alfred-retry-detail pre {
		white-space: pre-wrap;
		word-break: break-word;
		max-height: 12rem;
		overflow-y: auto;
	}
	.alfred-retry-actions {
		display: flex;
		gap: 0.5rem;
	}
</style>
