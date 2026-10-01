<script lang="ts">
	import type { Component } from 'svelte'
	import { AlfredClient } from './client.js'
	import { renderMarkdown } from './markdown.js'
	import { GenerationStream } from './session.svelte.js'
	import { buildTranscript, type ChatMessage } from './transcript.js'
	import AskHumanCard from './AskHumanCard.svelte'
	import HumanJsonFallback from './HumanJsonFallback.svelte'
	import RetryBox from './RetryBox.svelte'
	import StatusLine from './StatusLine.svelte'
	import ThoughtRow from './ThoughtRow.svelte'
	import ToolCallRow from './ToolCallRow.svelte'
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
	/**
	 * Send mode for the combo-button (plan §1.5). The main Send button uses
	 * the effective mode for the current chat status (see `isLive` below);
	 * the dropdown picks explicitly among the modes valid right now.
	 * Passed through to `onsend(prompt, mode)` — the APP maps it
	 * to its stream route (`emw`'s `/agent/stream` already supports all modes).
	 *
	 * - idle (no live generation: `stream.id` null or terminal
	 *   `done`/`error`): only `prompt` — `queue`/`steer`/`interrupt` are
	 *   `409` when idle on the BE.
	 * - live (`streaming`/`waiting`/`paused`): only
	 *   `queue`/`steer`/`interrupt` — `prompt` is `409` when running.
	 * `queue` is the live default (steer-inject); `prompt` is the idle default.
	 */
	export type ChatSendMode = 'prompt' | 'queue' | 'steer' | 'interrupt'
	let {
		credential,
		history = [],
		showThought = true,
		placeholder = 'Ask…',
		onsend = null,
		onerror = null,
		onstop = null,
		onretry = null,
		refreshStream = null,
		defaultMode = 'queue',
		toolIcons = {},
		statusLabels = {},
		labels = {},
		retryLabels = {},
		toolLabels = {},
		thoughtLabels = {},
		thoughtIcon = '💭',
		askHumanLabels = {},
		jsonFallbackLabels = {},
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
		 * Receives the send mode picked via the combo-button / keybindings.
		 */
		onsend?:
			| ((prompt: string, mode?: ChatSendMode) => Promise<StreamCredential | null>)
			| ((prompt: string) => Promise<StreamCredential | null>)
			| null
		/** Called with the error message on send/stream failures. */
		onerror?: ((message: string) => void) | null
		/**
		 * Called when the user hits Stop (Esc / Stop button). The host aborts
		 * the live generation (e.g. `POST …/stop`); the SSE loop is disposed
		 * locally regardless. Defaults to local dispose only.
		 */
		onstop?: (() => Promise<void> | void) | null
		/**
		 * Called when the user clicks Keep/Try-again on a retry box (or when
		 * a rate-limit countdown elapses). Receives the retry message id; the
		 * host resumes / re-prompts via its stream route. May return a fresh
		 * stream credential to attach (new generation, same contract as
		 * `onsend`), or null/void to stay on the current stream. Defaults to
		 * a no-op (box just dismisses).
		 */
		onretry?: ((msgId: string) => Promise<StreamCredential | null | void> | void) | null
		/**
		 * Re-mint the stream capability when Alfred answers `410` (generation
		 * ended) or `401` (expired). Called at most once per failed attach;
		 * the BE's `play` endpoint is the source — the FE never mints.
		 * Captured at construction (like `credential`); the host's function
		 * must read live state when invoked, not when passed.
		 */
		refreshStream?: (() => Promise<StreamCredential>) | null
		/** Main Send button mode (the dropdown overrides per-send). */
		defaultMode?: ChatSendMode
		/** Per-tool icons for `tool_call` rows (default 🔧). */
		toolIcons?: Record<string, string>
		/**
		 * Translated labels for `done/superseded|archived` status lines.
		 * Paraglide lives in the app, never in `emw-lib` — the host passes
		 * its `m.*()` strings here; English defaults apply otherwise.
		 */
		statusLabels?: Partial<Record<'superseded' | 'archived', string>>
		/**
		 * Translated composer strings (empty state, label, send/stop
		 * buttons, mode picker, streaming status). Same host-owned
		 * contract as `statusLabels`; English defaults apply otherwise.
		 * `sendMode`/`streamingSuffix` receive the current mode/status.
		 */
		labels?: Partial<{
			empty: string
			message: string
			sendMode: (mode: ChatSendMode) => string
			sending: string
			pickSendMode: string
			stop: string
			steerHint: string
			interruptHint: string
			streamingSuffix: string
			jsonFallbackSummary: (toolName: string) => string
			noSendHandler: string
			noLiveGeneration: string
		}>
		/** Translated `RetryBox` strings (forwarded). */
		retryLabels?: Partial<{
			details: string
			retrying: string
			keepRetry: string
			dismiss: string
			retryingIn: (seconds: number) => string
		}>
		/** Translated `ToolCallRow` strings (forwarded). */
		toolLabels?: Partial<{ arguments: string; output: string }>
		/** Translated `ThoughtRow` strings + icon (forwarded). */
		thoughtLabels?: Partial<{ thoughts: string }>
		thoughtIcon?: string
		/** Translated `AskHumanCard` strings (forwarded). */
		askHumanLabels?: Partial<{
			freeTextPlaceholder: string
			autopicked: string
			timedOut: string
			answer: string
			answering: string
		}>
		/** Translated `HumanJsonFallback` strings (forwarded). */
		jsonFallbackLabels?: Partial<{
			answerAsJson: string
			answer: string
			answering: string
			invalidJson: string
		}>
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
	const stream = new GenerationStream({
		client,
		// svelte-ignore state_referenced_locally: construction-time config, a remount picks up new values.
		refreshStream: refreshStream ?? undefined
	})
	$effect(() => () => stream.dispose())

	// Live credential: `onsend` may return a new credential for the CURRENT
	// mount (idle → prompt creates a generation without a remount). The
	// client must follow it — otherwise the next `attach()` targets the
	// stale construction-time URL/token and the answer never streams (B1).
	$effect(() => {
		if (liveCredential) client.setStreamCredential(liveCredential)
	})

	// Props are construction-time config — capture once; a remount picks up
	// new values. (`showThought` stays live: it only toggles rendering.
	// `onretry`/`onstop` stay live too: the host may pass spies after mount
	// in tests, and remounting on every callback change would drop the stream.)
	// svelte-ignore state_referenced_locally: construction-time config, a remount picks up new values.
	const initial = { credential, history }

	let draft = $state('')
	let sending = $state(false)
	/** Credential for the current mount: construction-time prop, updated when
	 * `onsend` returns a fresh one (idle → prompt without a remount). */
	// svelte-ignore state_referenced_locally: construction-time seed; later updates flow via `liveCredential`.
	let liveCredential = $state<StreamCredential | null>(credential)
	// svelte-ignore state_referenced_locally: construction-time default; the dropdown owns later changes.
	let sendMode = $state<ChatSendMode>(defaultMode)
	let modeMenuOpen = $state(false)

	/**
	 * Whether a generation is live (steerable). `stream.id` alone is not
	 * enough: after `done`/`error` the id is still set but the generation
	 * is terminal — the next send must `prompt` (a new generation), not
	 * `queue`/`steer`/`interrupt` (all `409` when idle on the BE).
	 */
	const isLive = $derived(
		stream.id !== null &&
			stream.status !== 'idle' &&
			stream.status !== 'done' &&
			stream.status !== 'error'
	)
	/** Modes valid right now: idle → `prompt` only; live → `queue`/`steer`/`interrupt`. */
	const availableModes = $derived<ChatSendMode[]>(
		isLive ? ['queue', 'steer', 'interrupt'] : ['prompt']
	)
	/**
	 * The mode the Send button actually uses. `sendMode` is the user's
	 * dropdown pick; when it is invalid for the current liveness (e.g. the
	 * `queue` default while idle, or `prompt` while live) fall back to the
	 * status default (`prompt` when idle, `queue` when live).
	 */
	const effectiveMode = $derived<ChatSendMode>(
		availableModes.includes(sendMode) ? sendMode : isLive ? 'queue' : 'prompt'
	)

	/** Scroll container for the stick-to-bottom effect (plan §1.6). */
	let messagesEl: HTMLDivElement | null = $state(null)
	let stickToBottom = $state(true)

	const transcript = $derived(
		buildTranscript(initial.history, stream.events, {
			text: stream.text || undefined,
			thought: stream.thought || undefined,
			showThought
		})
	)
	const busy = $derived(sending || stream.isStreaming)
	// The composer stays usable while streaming (queue/steer/interrupt need
	// it); only the in-flight `onsend` round-trip disables Send. `sending`
	// is true only between click and `onsend` resolving — hosts must resolve
	// promptly (fire-and-forget side effects) so live sends never wedge it.
	const canSend = $derived(draft.trim().length > 0 && !sending)
	const showStop = $derived(stream.isStreaming || sending)

	/** Descriptive icon for the composer status line (same emoji idiom as ToolCallRow/ThoughtRow). */
	const statusIcon = $derived(
		stream.status === 'streaming'
			? '●'
			: stream.status === 'waiting'
				? '⏳'
				: stream.status === 'paused'
					? '⏸'
					: stream.status === 'done'
						? '✅'
						: stream.status === 'error'
							? '⚠️'
							: '○'
	)

	function checkStick(): void {
		const el = messagesEl
		if (!el) return
		stickToBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48
	}

	// Stick-to-bottom only when already at bottom (never yank history readers).
	$effect(() => {
		void transcript.length
		const el = messagesEl
		if (el && stickToBottom) el.scrollTop = el.scrollHeight
	})

	function fail(message: string): void {
		stream.error = message
		onerror?.(message)
	}

	async function start(): Promise<void> {
		if (!initial.credential) return // idle: history only, no stream to attach
		// Fire-and-forget: the SSE loop lives until `done`/dispose; awaiting
		// it here would stall `send()`'s `sending` flag the same way.
		stream.attach(initial.credential).catch((err: unknown) => {
			fail(err instanceof Error ? err.message : String(err))
		})
	}
	void start()

	async function send(mode: ChatSendMode = effectiveMode): Promise<void> {
		const prompt = draft.trim()
		if (!prompt || sending) return
		if (!onsend) {
			fail(labels.noSendHandler ?? 'no send handler — the APP must provide onsend')
			return
		}
		// Clamp explicit modes to what the current liveness allows: `prompt`
		// is 409 when live, `queue`/`steer`/`interrupt` are 409 when idle.
		// (Keybindings can request steer/interrupt while idle; the dropdown
		// only offers valid modes so it needs no clamp.)
		const live = isLive
		if (!live && mode !== 'prompt') mode = 'prompt'
		if (live && mode === 'prompt') mode = 'queue'
		draft = ''
		sending = true
		try {
			const next = await (
				onsend as (p: string, m?: ChatSendMode) => Promise<StreamCredential | null>
			)(prompt, mode)
			if (next) {
				// New generation continues the visible conversation: keep the
				// prior generation's durable events so earlier turns stay
				// rendered (multi-turn retention), then attach the fresh
				// credential. Attach WITHOUT awaiting: the SSE loop lives
				// until `done` (or dispose); awaiting it would hold
				// `sending=true` and wedge the composer for the whole
				// generation.
				liveCredential = next
				void stream.attach(next, { keepEvents: true }).catch((err: unknown) => {
					fail(err instanceof Error ? err.message : String(err))
				})
			}
		} catch (err) {
			fail(err instanceof Error ? err.message : String(err))
		} finally {
			sending = false
		}
	}

	async function stop(): Promise<void> {
		try {
			await onstop?.()
		} catch (err) {
			fail(err instanceof Error ? err.message : String(err))
		} finally {
			stream.dispose()
			sending = false
		}
	}

	/**
	 * Retry continuation: `RetryBox` dismisses itself, then this attaches a
	 * fresh credential when the host returns one (new generation, same
	 * contract as `send()` — reset + fire-and-forget attach). A null/void
	 * return stays on the current stream (resume-in-place).
	 */
	async function continueAfterRetry(msgId: string): Promise<void> {
		let next: StreamCredential | null | void = null
		try {
			next = await onretry?.(msgId)
		} catch (err) {
			fail(err instanceof Error ? err.message : String(err))
			return
		}
		if (next) {
			liveCredential = next
			void stream.attach(next, { keepEvents: true }).catch((err: unknown) => {
				fail(err instanceof Error ? err.message : String(err))
			})
		}
	}

	function onkeydown(e: KeyboardEvent): void {
		if (e.key === 'Escape') {
			if (showStop) {
				e.preventDefault()
				void stop()
			}
			return
		}
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault()
			// vscode-style: Ctrl+Enter = steer, Alt+Enter = interrupt,
			// plain Enter = the combo-button's effective mode. `send()`
			// clamps steer/interrupt to `prompt` when idle, so the
			// shortcuts stay harmless on an idle chat.
			if (e.ctrlKey || e.metaKey) void send('steer')
			else if (e.altKey) void send('interrupt')
			else void send()
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
			fail(labels.noLiveGeneration ?? 'no live generation to answer')
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
			fail(labels.noLiveGeneration ?? 'no live generation to answer')
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
		bind:this={messagesEl}
		onscroll={checkStick}
	>
		{#each transcript as msg (msg.id)}
			{#if msg.kind === 'tool_call' && msg.tool}
				{@const toolMsg = msg as ChatMessage & {
					kind: 'tool_call'
					tool: NonNullable<ChatMessage['tool']>
				}}
				<ToolCallRow msg={toolMsg} icons={toolIcons} labels={toolLabels} />
			{:else if msg.kind === 'status' && msg.status}
				{@const statusMsg = msg as ChatMessage & {
					kind: 'status'
					status: NonNullable<ChatMessage['status']>
				}}
				<StatusLine msg={statusMsg} labels={statusLabels} />
			{:else if msg.kind === 'retry' && msg.retry}
				{@const retryMsg = msg as ChatMessage & {
					kind: 'retry'
					retry: NonNullable<ChatMessage['retry']>
				}}
				<RetryBox msg={retryMsg} onretry={continueAfterRetry} labels={retryLabels} />
			{:else if msg.kind === 'thought'}
				{#if showThought}
					{@const thoughtMsg = msg as ChatMessage & { kind: 'thought' }}
					<ThoughtRow msg={thoughtMsg} icon={thoughtIcon} labels={thoughtLabels} />
				{/if}
			{:else}
				<div
					class="alfred-chat-message alfred-chat-message-{msg.role}"
					class:alfred-chat-pending={msg.pending}
					data-testid="alfred-chat-message"
					data-role={msg.role}
				>
					{#if msg.role === 'assistant'}
						{@html renderMarkdown(msg.text)}
					{:else}
						{msg.text}
					{/if}
					{#if msg.role === 'human' && msg.human && !msg.human.answered}
						{@const receipt = answersByCall().get(msg.human.toolCallId)}
						{#if msg.human.toolName === 'ask_human' && msg.human.questions}
							<AskHumanCard
								questions={msg.human.questions}
								answered={receipt?.answers ?? null}
								onanswer={(answers) => answerAskHuman(msg.human!.toolCallId, answers)}
								labels={askHumanLabels}
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
								<summary
									>{labels.jsonFallbackSummary?.(msg.human.toolName) ??
										`Answer in JSON (no renderer registered for ${msg.human.toolName})`}</summary
								>
								<HumanJsonFallback
									toolCallId={msg.human.toolCallId}
									answered={receipt?.value ?? null}
									onanswer={(value) => answerGeneric(msg.human!.toolCallId, value)}
									labels={jsonFallbackLabels}
								/>
							</details>
						{/if}
					{/if}
				</div>
			{/if}
		{:else}
			<p class="alfred-chat-empty" data-testid="alfred-chat-empty">
				{labels.empty ?? 'No messages yet.'}
			</p>
		{/each}
	</div>

	{#if stream.error}
		<p class="alfred-chat-error" data-testid="alfred-chat-error" role="alert">{stream.error}</p>
	{/if}

	<div class="alfred-chat-composer">
		<!-- Combo-button: main Send uses the effective mode for the current
			chat status (prompt when idle, queue/steer/interrupt when live);
			the dropdown only offers the modes valid right now. -->
		<label class="alfred-chat-label" for="alfred-chat-input">{labels.message ?? 'Message'}</label>
		<textarea
			id="alfred-chat-input"
			data-testid="alfred-chat-input"
			bind:value={draft}
			{placeholder}
			rows={2}
			{onkeydown}
		></textarea>
		<div class="alfred-chat-actions">
			<span class="alfred-chat-send-group">
				<button
					type="button"
					class="alfred-chat-send"
					data-testid="alfred-chat-send"
					disabled={!canSend}
					title="Send ({effectiveMode}, Enter)"
					onclick={() => void send()}
				>
					{sending
						? (labels.sending ?? 'Sending…')
						: (labels.sendMode?.(effectiveMode) ?? `Send (${effectiveMode})`)}
				</button>
				{#if availableModes.length > 1}
					<button
						type="button"
						class="alfred-chat-mode-toggle"
						data-testid="alfred-chat-mode-toggle"
						title={labels.pickSendMode ?? 'Pick send mode'}
						aria-expanded={modeMenuOpen}
						aria-haspopup="menu"
						onclick={() => (modeMenuOpen = !modeMenuOpen)}
					>
						▾
					</button>
				{/if}
			</span>
			{#if showStop}
				<button
					type="button"
					class="alfred-chat-stop"
					data-testid="alfred-chat-stop"
					title="Stop (Esc)"
					onclick={() => void stop()}
				>
					{labels.stop ?? 'Stop'}
				</button>
			{/if}
			<p class="alfred-chat-status" data-testid="alfred-chat-status" aria-live="polite">
				<span aria-hidden="true">{statusIcon}</span>
				<span
					>{stream.status}{stream.isStreaming
						? (labels.streamingSuffix ?? ' · streaming')
						: ''}</span
				>
			</p>
		</div>
		{#if modeMenuOpen && availableModes.length > 1}
			<div class="alfred-chat-modes" data-testid="alfred-chat-modes" role="menu">
				{#each availableModes as mode (mode)}
					<button
						type="button"
						role="menuitemradio"
						aria-checked={effectiveMode === mode}
						data-testid="alfred-chat-mode-{mode}"
						data-active={effectiveMode === mode}
						title={mode === 'steer'
							? (labels.steerHint ?? 'Steer (Ctrl+Enter)')
							: mode === 'interrupt'
								? (labels.interruptHint ?? 'Interrupt (Alt+Enter)')
								: mode}
						onclick={() => {
							sendMode = mode
							modeMenuOpen = false
						}}
					>
						{mode}
					</button>
				{/each}
			</div>
		{/if}
	</div>
</div>

<style>
	/* Self-contained shadcn-shaped styles (same contract as `LoginScreen`:
	 * tokens fall back to the host's shadcn palette — `emw` — or to these
	 * neutral defaults in hosts without one — `arb2b`). No Tailwind
	 * utilities, no bits-ui: plain `<style>` renders everywhere. */
	.alfred-chat {
		--alfred-bg: var(--card, oklch(1 0 0));
		--alfred-fg: var(--card-foreground, oklch(0.145 0 0));
		--alfred-muted: var(--muted-foreground, oklch(0.556 0 0));
		--alfred-border: var(--border, oklch(0.922 0 0));
		--alfred-input: var(--input, oklch(0.922 0 0));
		--alfred-ring: var(--ring, oklch(0.708 0 0));
		--alfred-primary: var(--primary, oklch(0.205 0 0));
		--alfred-primary-fg: var(--primary-foreground, oklch(0.985 0 0));
		--alfred-user-bg: var(--secondary, oklch(0.97 0 0));
		--alfred-user-fg: var(--secondary-foreground, oklch(0.205 0 0));
		--alfred-destructive: var(--destructive, oklch(0.577 0.245 27.325));
		--alfred-radius: var(--radius, 0.625rem);
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
	.alfred-chat-message {
		max-width: 100%;
		word-break: break-word;
	}
	.alfred-chat-message-user {
		align-self: flex-end;
		max-width: 85%;
		padding: 0.5rem 0.75rem;
		border-radius: calc(var(--alfred-radius) - 2px);
		border-bottom-right-radius: 2px;
		background: var(--alfred-user-bg);
		color: var(--alfred-user-fg);
		font-size: 0.875rem;
		line-height: 1.5;
		white-space: pre-wrap;
	}
	.alfred-chat-message-assistant {
		align-self: flex-start;
	}
	.alfred-chat-message-tool,
	.alfred-chat-message-system {
		align-self: center;
		opacity: 0.75;
	}
	.alfred-chat-pending {
		opacity: 0.85;
	}
	.alfred-chat-error {
		color: var(--alfred-destructive);
	}
	.alfred-chat-composer {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}
	.alfred-chat-composer textarea {
		border: 1px solid var(--alfred-input);
		border-radius: calc(var(--alfred-radius) - 2px);
		background: transparent;
		color: inherit;
		padding: 0.5rem 0.75rem;
		font-size: 0.875rem;
		font-family: inherit;
		resize: vertical;
		outline: none;
		transition:
			border-color 0.15s,
			box-shadow 0.15s;
	}
	.alfred-chat-composer textarea:focus-visible {
		border-color: var(--alfred-ring);
		box-shadow: 0 0 0 3px color-mix(in oklch, var(--alfred-ring) 50%, transparent);
	}
	.alfred-chat-actions {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}
	/* Joined combo-send: primary Send + attached mode toggle. */
	.alfred-chat-send-group {
		display: inline-flex;
		align-items: stretch;
	}
	.alfred-chat-send {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		height: 2.25rem;
		padding-inline: 1rem;
		border: 1px solid transparent;
		border-radius: calc(var(--alfred-radius) - 2px) 0 0 calc(var(--alfred-radius) - 2px);
		border-right: 1px solid color-mix(in oklch, var(--alfred-primary-fg) 30%, transparent);
		background: var(--alfred-primary);
		color: var(--alfred-primary-fg);
		font-size: 0.875rem;
		font-weight: 500;
		cursor: pointer;
		transition:
			opacity 0.15s,
			box-shadow 0.15s;
	}
	.alfred-chat-send:hover:not(:disabled) {
		opacity: 0.9;
	}
	.alfred-chat-send:disabled {
		opacity: 0.5;
		pointer-events: none;
	}
	/* Single-button case (no mode toggle): restore full radius. */
	.alfred-chat-send-group > .alfred-chat-send:only-child {
		border-radius: calc(var(--alfred-radius) - 2px);
		border-right: 1px solid transparent;
	}
	.alfred-chat-send:focus-visible,
	.alfred-chat-mode-toggle:focus-visible,
	.alfred-chat-stop:focus-visible {
		outline: none;
		box-shadow: 0 0 0 3px color-mix(in oklch, var(--alfred-ring) 50%, transparent);
		z-index: 1;
	}
	.alfred-chat-mode-toggle {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		height: 2.25rem;
		padding-inline: 0.5rem;
		border: 1px solid transparent;
		border-left: none;
		border-radius: 0 calc(var(--alfred-radius) - 2px) calc(var(--alfred-radius) - 2px) 0;
		background: var(--alfred-primary);
		color: var(--alfred-primary-fg);
		font-size: 0.75rem;
		cursor: pointer;
		transition: opacity 0.15s;
	}
	.alfred-chat-mode-toggle:hover {
		opacity: 0.9;
	}
	.alfred-chat-stop {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		height: 2.25rem;
		padding-inline: 1rem;
		border: 1px solid var(--alfred-input);
		border-radius: calc(var(--alfred-radius) - 2px);
		background: transparent;
		color: inherit;
		font-size: 0.875rem;
		font-weight: 500;
		cursor: pointer;
		transition:
			border-color 0.15s,
			background 0.15s;
	}
	.alfred-chat-stop:hover {
		border-color: var(--alfred-ring);
	}
	/* Inline status: muted + italic, like ThoughtRow. */
	.alfred-chat-status {
		margin: 0;
		display: flex;
		align-items: baseline;
		gap: 0.375rem;
		font-size: 0.8rem;
		font-style: italic;
		color: var(--alfred-muted);
		opacity: 0.75;
	}
	.alfred-chat-modes {
		display: flex;
		gap: 0.25rem;
		padding: 0.25rem;
		border: 1px solid var(--alfred-border);
		border-radius: calc(var(--alfred-radius) - 2px);
		background: var(--alfred-bg);
		color: var(--alfred-fg);
		box-shadow: 0 4px 12px rgb(0 0 0 / 0.12);
		align-self: flex-start;
	}
	.alfred-chat-modes button {
		border: 1px solid transparent;
		border-radius: calc(var(--alfred-radius) - 4px);
		background: transparent;
		color: inherit;
		padding: 0.25rem 0.5rem;
		font-size: 0.8rem;
		font-weight: 500;
		cursor: pointer;
	}
	.alfred-chat-modes button:hover {
		border-color: var(--alfred-ring);
	}
	.alfred-chat-modes button[data-active='true'] {
		background: var(--alfred-primary);
		border-color: var(--alfred-primary);
		color: var(--alfred-primary-fg);
	}
	.alfred-chat-message-assistant :global(p),
	.alfred-chat-message-assistant :global(ul),
	.alfred-chat-message-assistant :global(pre),
	.alfred-chat-message-assistant :global(blockquote) {
		margin: 0.25rem 0;
	}
	.alfred-chat-message-assistant :global(pre) {
		max-height: 12rem;
		overflow-y: auto;
		white-space: pre-wrap;
		word-break: break-word;
	}
	.alfred-chat-label {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip: rect(0 0 0 0);
	}
</style>
