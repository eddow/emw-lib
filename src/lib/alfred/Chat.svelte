<script lang="ts">
	import { AlfredClient } from './client.js'
	import { GenerationStream } from './session.svelte.js'
	import { buildTranscript } from './transcript.js'
	import type { StreamCredential } from './types.js'

	/**
	 * Minimal generic chat over a {@link GenerationStream} (stream-only).
	 *
	 * Owns its stream (never a module singleton — `$state` at module scope
	 * would leak across SSR renders). The parent supplies the stream
	 * credential (`{ generation_id, stream_token, stream_url }` as served by
	 * the BE's prompt/play response, forwarded over the app's priv channel —
	 * the URL travels WITH the token, never hardcoded).
	 *
	 * Sending goes browser → APP action (`onsend`) → per-policy APP call →
	 * new credential back via `credential` prop change (remount or `attach`).
	 * This component never creates/prompts/steers directly.
	 *
	 * ```svelte
	 * <AlfredChat credential={{ generation_id, stream_token, stream_url }} onsend={send} />
	 * ```
	 */
	let {
		credential,
		showThought = false,
		placeholder = 'Ask…',
		onsend = null,
		onerror = null
	}: {
		/**
		 * Stream credential (`{ generation_id, stream_token, stream_url }`)
		 * as served by the BE's prompt/play response. The base URL comes from
		 * the credential — the browser never hardcodes a host.
		 */
		credential: StreamCredential
		/** Show the live reasoning draft alongside the answer draft. */
		showThought?: boolean
		/** Composer placeholder. */
		placeholder?: string
		/**
		 * Called with the draft prompt. The host runs its APP action
		 * (per-policy prompt/queue/steer/interrupt) and returns the new
		 * stream credential to attach (or null to stay on the current stream).
		 */
		onsend?: ((prompt: string) => Promise<StreamCredential | null>) | null
		/** Called with the error message on send/stream failures. */
		onerror?: ((message: string) => void) | null
	} = $props()

	const stream = new GenerationStream({
		// svelte-ignore state_referenced_locally: construction-time config, a remount picks up new values.
		client: new AlfredClient({
			baseUrl: credential.stream_url,
			streamToken: credential.stream_token
		})
	})
	$effect(() => () => stream.dispose())

	// Props are construction-time config — capture once; a remount picks up
	// new values. (`showThought` stays live: it only toggles rendering.)
	// svelte-ignore state_referenced_locally: construction-time config, a remount picks up new values.
	const initial = { credential }

	let draft = $state('')
	let sending = $state(false)

	const transcript = $derived(
		buildTranscript([], stream.events, {
			text: stream.text || undefined,
			thought: stream.thought || undefined,
			showThought
		})
	)
	const busy = $derived(sending || stream.isStreaming)
	const canSend = $derived(draft.trim().length > 0 && !sending && stream.id !== null)

	function fail(message: string): void {
		stream.error = message
		onerror?.(message)
	}

	async function start(): Promise<void> {
		try {
			await stream.attach(initial.credential)
		} catch (err) {
			fail(err instanceof Error ? err.message : String(err))
		}
	}
	void start()

	async function send(): Promise<void> {
		const prompt = draft.trim()
		if (!prompt || sending || !stream.id) return
		if (!onsend) {
			fail('no send handler — the APP must provide onsend')
			return
		}
		draft = ''
		sending = true
		try {
			const next = await onsend(prompt)
			if (next) await stream.attach(next)
		} catch (err) {
			fail(err instanceof Error ? err.message : String(err))
		} finally {
			sending = false
		}
	}

	function onkeydown(e: KeyboardEvent): void {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault()
			void send()
		}
	}
</script>

<div class="alfred-chat" data-testid="alfred-chat">
	<div
		class="alfred-chat-messages"
		data-testid="alfred-chat-messages"
		role="log"
		aria-live="polite"
	>
		{#each transcript as msg (msg.id)}
			<div
				class="alfred-chat-message alfred-chat-message-{msg.role}"
				class:alfred-chat-pending={msg.pending}
				class:alfred-chat-thought={msg.thought}
				data-testid="alfred-chat-message"
				data-role={msg.role}
			>
				{msg.text}
			</div>
		{:else}
			<p class="alfred-chat-empty" data-testid="alfred-chat-empty">No messages yet.</p>
		{/each}
	</div>

	{#if stream.error}
		<p class="alfred-chat-error" data-testid="alfred-chat-error" role="alert">{stream.error}</p>
	{/if}

	<div class="alfred-chat-composer">
		<!-- Send button kept: this is a chat composer, not a filter — Enter
			sends (see onkeydown) and the button is the explicit send action. -->
		<label class="alfred-chat-label" for="alfred-chat-input">Message</label>
		<textarea
			id="alfred-chat-input"
			data-testid="alfred-chat-input"
			bind:value={draft}
			{placeholder}
			rows={2}
			disabled={stream.id === null}
			{onkeydown}
		></textarea>
		<button
			type="button"
			data-testid="alfred-chat-send"
			disabled={!canSend}
			onclick={() => void send()}
		>
			{sending ? 'Sending…' : 'Send'}
		</button>
	</div>

	<p class="alfred-chat-status" data-testid="alfred-chat-status" aria-live="polite">
		{stream.status}{stream.isStreaming ? ' · streaming' : ''}
	</p>
</div>

<style>
	.alfred-chat {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
	.alfred-chat-messages {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		max-height: 24rem;
		overflow-y: auto;
	}
	.alfred-chat-message-user {
		align-self: flex-end;
	}
	.alfred-chat-message-assistant {
		align-self: flex-start;
	}
	.alfred-chat-message-tool,
	.alfred-chat-message-system {
		align-self: center;
		opacity: 0.75;
	}
	.alfred-chat-thought {
		font-style: italic;
		opacity: 0.7;
	}
	.alfred-chat-pending {
		opacity: 0.85;
	}
	.alfred-chat-error {
		color: red;
	}
	.alfred-chat-composer {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}
	.alfred-chat-label {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip: rect(0 0 0 0);
	}
</style>
