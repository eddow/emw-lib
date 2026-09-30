<script lang="ts">
	import type { Component } from 'svelte'
	import { AlfredClient } from './client.js'
	import { GenerationStream } from './session.svelte.js'
	import { buildTranscript } from './transcript.js'
	import AskHumanCard from './AskHumanCard.svelte'
	import HumanJsonFallback from './HumanJsonFallback.svelte'
	import type { HistoryItem, HumanAnswer, StreamCredential } from './types.js'

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
	 * Human tools (butler §9) render inline: `ask_human` uses the built-in
	 * {@link AskHumanCard}; apps register their own `{tool: ToolComponent}`
	 * renderers keyed by tool name via `humanTools`. Answers post FE →
	 * Alfred direct (stream-token auth, no BE hop).
	 *
	 * ```svelte
	 * <AlfredChat credential={{ generation_id, stream_token, stream_url }} onsend={send} />
	 * ```
	 */
	export interface HumanToolComponentProps {
		toolCallId: string
		toolName: string
		/** Raw model arguments (the question). */
		parameters: Record<string, unknown>
		answered: unknown | null
		onanswer: (value: unknown) => Promise<void>
	}
	let {
		credential,
		history = [],
		showThought = false,
		placeholder = 'Ask…',
		onsend = null,
		onerror = null,
		humanTools = {}
	}: {
		/**
		 * Stream credential (`{ generation_id, stream_token, stream_url }`)
		 * as served by the BE's prompt/play response. The base URL comes from
		 * the credential — the browser never hardcodes a host. `null` when no
		 * generation is live: the transcript still renders from `history` and
		 * the first send creates a generation via `onsend`.
		 */
		credential: StreamCredential | null
		/**
		 * Durable conversation history (Alfred `/history`, fetched by the APP's
		 * `load`). Rendered before the live stream events, so a reload shows the
		 * prior turns instead of an empty transcript. Construction-time config —
		 * a remount picks up new values.
		 */
		history?: HistoryItem[]
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
		/**
		 * FE-registered human-tool renderers, keyed by tool name. Each
		 * receives the raw model arguments as `parameters` and posts its
		 * produced value via `onanswer`. `ask_human` needs no entry (built
		 * in); unknown tools with no entry render a JSON fallback.
		 */
		humanTools?: Record<string, Component<HumanToolComponentProps>>
	} = $props()

	const client = new AlfredClient({
		// svelte-ignore state_referenced_locally: construction-time config, a remount picks up new values.
		baseUrl: credential?.stream_url,
		// svelte-ignore state_referenced_locally: construction-time config, a remount picks up new values.
		streamToken: credential?.stream_token
	})
	const stream = new GenerationStream({ client })
	$effect(() => () => stream.dispose())

	// Props are construction-time config — capture once; a remount picks up
	// new values. (`showThought` stays live: it only toggles rendering.)
	// svelte-ignore state_referenced_locally: construction-time config, a remount picks up new values.
	const initial = { credential, history }

	let draft = $state('')
	let sending = $state(false)

	const transcript = $derived(
		buildTranscript(initial.history, stream.events, {
			text: stream.text || undefined,
			thought: stream.thought || undefined,
			showThought
		})
	)
	const busy = $derived(sending || stream.isStreaming)
	const canSend = $derived(draft.trim().length > 0 && !sending)

	function fail(message: string): void {
		stream.error = message
		onerror?.(message)
	}

	async function start(): Promise<void> {
		if (!initial.credential) return // idle: history only, no stream to attach
		try {
			await stream.attach(initial.credential)
		} catch (err) {
			fail(err instanceof Error ? err.message : String(err))
		}
	}
	void start()

	async function send(): Promise<void> {
		const prompt = draft.trim()
		if (!prompt || sending) return
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

	/**
	 * Answers already received for a question, matched by `tool_call_id`:
	 * lets a `human_question` render as answered (disabled card + receipt)
	 * once its `human_answer` arrives, and keeps history replay working
	 * (question and answer are separate durable events).
	 */
	const answersByCall = $derived(() => {
		const map = new Map<string, { answers?: HumanAnswer[]; value?: unknown }>()
		for (const msg of transcript) {
			if (msg.role === 'human' && msg.human?.answered) {
				map.set(msg.human.toolCallId, {
					answers: msg.human.answers,
					value: msg.human.value
				})
			}
		}
		return map
	})

	async function answerAskHuman(toolCallId: string, answers: HumanAnswer[]): Promise<void> {
		if (!stream.id) {
			fail('no live generation to answer')
			return
		}
		try {
			await client.answerHuman(stream.id, toolCallId, { answers })
		} catch (err) {
			fail(err instanceof Error ? err.message : String(err))
			throw err
		}
	}

	async function answerGeneric(toolCallId: string, value: unknown): Promise<void> {
		if (!stream.id) {
			fail('no live generation to answer')
			return
		}
		try {
			await client.answerHuman(stream.id, toolCallId, { value })
		} catch (err) {
			fail(err instanceof Error ? err.message : String(err))
			throw err
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
				{#if msg.role === 'human' && msg.human && !msg.human.answered}
					{@const receipt = answersByCall().get(msg.human.toolCallId)}
					{#if msg.human.toolName === 'ask_human' && msg.human.questions}
						<AskHumanCard
							questions={msg.human.questions}
							answered={receipt?.answers ?? null}
							onanswer={(answers) => answerAskHuman(msg.human!.toolCallId, answers)}
						/>
					{:else if humanTools[msg.human.toolName]}
						{@const Tool = humanTools[msg.human.toolName]}
						<Tool
							toolCallId={msg.human.toolCallId}
							toolName={msg.human.toolName}
							parameters={(msg.human.questions
								? { questions: msg.human.questions }
								: (msg.human.parameters ?? {})) as Record<string, unknown>}
							answered={receipt?.value ?? null}
							onanswer={(value) => answerGeneric(msg.human!.toolCallId, value)}
						/>
					{:else}
						<details class="alfred-human-fallback" data-testid="alfred-human-fallback">
							<summary>Answer in JSON (no renderer registered for {msg.human.toolName})</summary>
							<HumanJsonFallback
								toolCallId={msg.human.toolCallId}
								answered={receipt?.value ?? null}
								onanswer={(value) => answerGeneric(msg.human!.toolCallId, value)}
							/>
						</details>
					{/if}
				{/if}
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
