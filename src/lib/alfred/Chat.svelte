<script lang="ts">
	import { AlfredClient } from './client.js'
	import { ButlerSession, type SendMode } from './session.svelte.js'
	import { buildTranscript } from './transcript.js'
	import type { AlfredCredential, CreateSessionInput } from './types.js'

	/**
	 * Minimal generic chat over a {@link ButlerSession}.
	 *
	 * Owns its session (never a module singleton — `$state` at module scope
	 * would leak across SSR renders). The parent supplies the credential
	 * (`{ token, base_url }` as served by `emw`'s token route — the URL
	 * travels WITH the token, never hardcoded) plus the agent input;
	 * everything else — create/attach, the SSE loop, the transcript — lives
	 * here.
	 *
	 * `sessionId` is **bindable**: pass `null`/`undefined` and the chat
	 * creates a session and writes its id back; pass an id and the chat
	 * recovers that session (history + live stream) instead.
	 *
	 * ```svelte
	 * <AlfredChat
	 *   credential={{ token, base_url }}
	 *   agent={{ model }}
	 *   bind:sessionId={chatSessionId}
	 * />
	 * ```
	 */
	let {
		credential,
		agent,
		toolset,
		initialPrompt,
		sessionId = $bindable(null),
		sendMode = 'queue',
		showThought = false,
		placeholder = 'Ask…',
		onerror = null
	}: {
		/**
		 * Browser credential (`{ token, expires_at?, base_url? }`) as served
		 * by `emw`'s `POST /(priv)/agent/token`. The base URL comes from the
		 * credential — the browser never hardcodes a host.
		 */
		credential: AlfredCredential
		/** Agent block for `POST /sessions` (model required). */
		agent: CreateSessionInput['agent']
		/** Optional toolset (every tool `callback` — see §9). */
		toolset?: CreateSessionInput['toolset']
		/** First user message, sent on `POST /sessions`. */
		initialPrompt?: string
		/**
		 * Bound session id. `null`/`undefined` → create a session and write
		 * its id back; an id → attach + recover history instead of creating.
		 */
		sessionId?: string | null
		/** How prompts reach a running agent (`queue` | `steer` | `redirect`). */
		sendMode?: SendMode
		/** Show the live reasoning draft alongside the answer draft. */
		showThought?: boolean
		/** Composer placeholder. */
		placeholder?: string
		/** Called with the error message on create/send/stream failures. */
		onerror?: ((message: string) => void) | null
	} = $props()

	const session = new ButlerSession({
		// svelte-ignore state_referenced_locally: construction-time config, a remount picks up new values.
		client: new AlfredClient({ baseUrl: credential.base_url, authToken: credential.token })
	})
	$effect(() => () => session.dispose())

	// Props are construction-time config (transport + agent input), like
	// `ButlerSessionOptions` — capture them once, the same way `session`
	// captures the credential above. A remount picks up new values.
	// (`showThought` stays live: it only toggles rendering of the draft.
	// `sessionId` is bindable but read once at start: a later parent change
	// means "a different chat", which needs a remount, not a silent switch.)
	// svelte-ignore state_referenced_locally: construction-time config, a remount picks up new values.
	const initial = { agent, toolset, initialPrompt, sessionId, sendMode }

	let draft = $state('')
	let sending = $state(false)

	const transcript = $derived(
		buildTranscript(session.history, session.events, {
			text: session.text || undefined,
			thought: session.thought || undefined,
			showThought
		})
	)
	const busy = $derived(sending || session.isStreaming)
	const canSend = $derived(draft.trim().length > 0 && !sending && session.id !== null)

	function fail(message: string): void {
		session.error = message
		onerror?.(message)
	}

	async function start(): Promise<void> {
		try {
			if (initial.sessionId) {
				// Recover: attach the stream, then render durable history.
				await session.attach(initial.sessionId)
				await session.loadHistory()
			} else {
				// Create: POST /sessions, then bind the new id back so the
				// parent (chat row, URL, …) can persist it.
				const id = await session.create({
					agent: initial.agent,
					toolset: initial.toolset,
					initial_prompt: initial.initialPrompt
				})
				sessionId = id
				await session.loadHistory()
			}
		} catch (err) {
			fail(err instanceof Error ? err.message : String(err))
		}
	}
	void start()

	async function send(): Promise<void> {
		const prompt = draft.trim()
		if (!prompt || sending || !session.id) return
		draft = ''
		sending = true
		try {
			await session.send(prompt, initial.sendMode)
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

	{#if session.error}
		<p class="alfred-chat-error" data-testid="alfred-chat-error" role="alert">{session.error}</p>
	{/if}

	<div class="alfred-chat-composer">
		<label class="alfred-chat-label" for="alfred-chat-input">Message</label>
		<textarea
			id="alfred-chat-input"
			data-testid="alfred-chat-input"
			bind:value={draft}
			{placeholder}
			rows={2}
			disabled={session.id === null}
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
		{session.status}{session.isStreaming ? ' · streaming' : ''}
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
