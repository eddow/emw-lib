/**
 * GenerationStream — Svelte 5 runes wrapper around {@link AlfredClient}'s
 * stream methods (see `docs/alfred.md`: stream-only FE, control via the BE).
 *
 * Stream-ONLY: it owns a stream capability (`StreamCredential` from the BE's
 * prompt/play response, forwarded over the app's priv channel), never
 * creates/prompts/steers directly. `send()` goes browser → APP action →
 * per-policy APP call → new credential back, then the component attaches the
 * new stream.
 *
 * The pure core (`types.ts`, `client.ts`, `stream.ts`) stays framework-free;
 * this module is the one Svelte-aware layer on top. It owns the lifecycle a
 * consumer would otherwise wire by hand: attach, the SSE loop, the reconnect
 * cursor, and the reactive state a component renders.
 *
 * ```svelte
 * <script lang="ts">
 *   import { AlfredClient, GenerationStream } from '$lib'
 *   const stream = new GenerationStream({ client: new AlfredClient({ baseUrl }) })
 *   $effect(() => () => stream.dispose())
 * </script>
 * <p>{stream.text}</p>
 * ```
 *
 * Rules:
 * - **Never a module-level singleton.** `$state` at module scope is shared
 *   across requests during SSR and would leak one stream into another's
 *   render. Instantiate per component (or via `setContext`).
 * - **Explicit `attach()` / `dispose()`, not `$effect`.** `$effect` only runs
 *   inside a component or an effect root, so a class built in a plain module
 *   or a test would silently never subscribe. Teardown is the caller's job
 *   (one `$effect(() => () => stream.dispose())` at the call site).
 * - **Reuse {@link applyLiveEvent}.** The reducer is already unit-tested for
 *   the delta/final/cursor rules; this class is a lifecycle shell over it,
 *   never a second implementation.
 */

import { type AlfredClient, AlfredError } from './client.js'
import { applyLiveEvent, createStreamState, isDeltaEvent, type StreamState } from './stream.js'
import type { LiveEvent, StreamCredential } from './types.js'

/**
 * Default cap on {@link GenerationStream.events}. Deltas are 10–100x the finals,
 * so an uncapped log grows without bound on a long generation. Durable events
 * are never dropped; only deltas are trimmed.
 */
export const DEFAULT_EVENT_LOG_LIMIT = 500

/** Stream lifecycle. `waiting` = a human tool is pending an answer (§9). */
export type GenerationStatus = 'idle' | 'streaming' | 'waiting' | 'paused' | 'done' | 'error'

export interface GenerationStreamOptions {
	/** The transport. Construct with `baseUrl: env.ALFRED_PUBLIC_URL` in `emw`. */
	client: AlfredClient
	/** Auto-attach the SSE loop on `attach()`. Default `true`. */
	autoStream?: boolean
	/**
	 * Max entries kept in {@link GenerationStream.events}. Default
	 * {@link DEFAULT_EVENT_LOG_LIMIT}. Durable events are always kept; only
	 * deltas are trimmed, oldest first. `0` disables the log entirely.
	 */
	eventLogLimit?: number
	/**
	 * Re-mint the stream capability when Alfred answers `410` (generation
	 * ended) or `401` (expired). Called at most once per failed attach; the
	 * returned credential is installed via
	 * {@link AlfredClient.setStreamCredential} and the attach is retried, so
	 * the expiry is invisible to the user. The BE's `play` endpoint is the
	 * source — the FE never mints.
	 */
	refreshStream?: () => Promise<StreamCredential>
}

/**
 * Backwards-compatible alias: `ButlerSession` was the session-scoped stream
 * owner; the APP now owns `AlfredSession` (BE-side) and the FE owns this
 * `GenerationStream`. Kept so existing imports keep compiling during migration.
 */
export type ButlerStatus = GenerationStatus
export type SendMode = 'queue' | 'steer' | 'interrupt'

export class GenerationStream {
	#client: AlfredClient
	#autoStream: boolean
	#eventLogLimit: number
	#refreshStream: (() => Promise<StreamCredential>) | undefined
	/** Reactive so {@link isStreaming} tracks attach/dispose. */
	#abort = $state<AbortController | null>(null)

	/** Server generation id, `null` until `attach()`. */
	id = $state<string | null>(null)
	/** Lifecycle status. */
	status = $state<GenerationStatus>('idle')
	/** Live drafts + reconnect cursor, reduced by {@link applyLiveEvent}. */
	stream = $state<StreamState>(createStreamState())
	/**
	 * Recent live events (durable + deltas), in order. Bounded by
	 * {@link GenerationStreamOptions.eventLogLimit}: durable events are always
	 * kept, deltas are trimmed oldest-first.
	 */
	events = $state<LiveEvent[]>([])
	/** Last transport/stream error message, cleared on the next action. */
	error = $state<string | null>(null)
	/** Resolves when the current SSE loop ends. Await it in tests. */
	attached: Promise<void> = Promise.resolve()

	/** Current answer draft. */
	readonly text = $derived(this.stream.text)
	/** Current reasoning draft. */
	readonly thought = $derived(this.stream.thought)
	/** Highest durable `seq` seen — the reconnect cursor. */
	readonly lastSeq = $derived(this.stream.lastSeq)
	/** Pending human asks (§9), cleared as answers arrive. */
	readonly pendingHuman = $derived(this.stream.pendingHuman)
	/** Whether a human tool is waiting for an answer. */
	readonly isWaitingHuman = $derived(this.stream.status === 'waiting')
	/**
	 * Whether the SSE loop is currently attached. Derived from the abort
	 * controller, not from `status`.
	 */
	readonly isStreaming = $derived(this.#abort !== null)

	constructor(opts: GenerationStreamOptions) {
		this.#client = opts.client
		this.#autoStream = opts.autoStream ?? true
		this.#eventLogLimit = opts.eventLogLimit ?? DEFAULT_EVENT_LOG_LIMIT
		this.#refreshStream = opts.refreshStream
	}

	/** The underlying transport (for calls this wrapper does not cover). */
	get client(): AlfredClient {
		return this.#client
	}

	/**
	 * Attach (or re-attach) the SSE loop for a generation credential,
	 * replaying durable events since {@link lastSeq}. Aborts any previous
	 * loop first. Returns a promise that resolves when the loop ends; also
	 * stored on {@link attached}.
	 */
	attach(credential: StreamCredential | string | null = null): Promise<void> {
		const gid = typeof credential === 'string' ? credential : (credential?.generation_id ?? this.id)
		if (!gid)
			return Promise.reject(new AlfredError('no generation id to attach', { code: 'validation' }))
		if (credential && typeof credential !== 'string') {
			this.#client.setStreamCredential(credential)
		}
		this.#abort?.abort()
		const ac = new AbortController()
		this.#abort = ac
		this.id = gid
		this.status = 'streaming'
		this.error = null
		const run = this.#consume(gid, ac)
		this.attached = run
		return run
	}

	/** Consume the SSE generator, reducing each event into reactive state. */
	async #consume(gid: string, ac: AbortController): Promise<void> {
		try {
			await this.#withStream(async () => {
				for await (const evt of this.#client.streamEvents(gid, this.stream.lastSeq, ac.signal)) {
					this.#ingest(evt)
				}
			})
		} catch (err) {
			if (!ac.signal.aborted) {
				this.error = err instanceof Error ? err.message : String(err)
				this.status = 'error'
			}
		} finally {
			if (this.#abort === ac) this.#abort = null
		}
	}

	/**
	 * Run `fn`, refreshing the stream capability and retrying once on
	 * `401`/`410`. Without {@link GenerationStreamOptions.refreshStream} the
	 * error propagates unchanged.
	 */
	async #withStream<T>(fn: () => Promise<T>): Promise<T> {
		try {
			return await fn()
		} catch (err) {
			if (
				!this.#refreshStream ||
				!(err instanceof AlfredError) ||
				(err.status !== 401 && err.status !== 410)
			)
				throw err
			const credential = await this.#refreshStream()
			this.#client.setStreamCredential(credential)
			if (credential.generation_id !== this.id) {
				this.id = credential.generation_id
				return await fn()
			}
			return await fn()
		}
	}

	/** Fold one live event into `stream` + `events`, and sync `status`. */
	#ingest(evt: LiveEvent): void {
		this.stream = applyLiveEvent(this.stream, evt)
		this.#pushEvent(evt)
		if (this.stream.status === 'done') this.status = 'done'
		else if (this.stream.status === 'error') this.status = 'error'
		else if (this.stream.status === 'waiting') this.status = 'waiting'
		else this.status = 'streaming'
	}

	/**
	 * Append to the bounded event log. Durable events are always kept; when the
	 * cap is exceeded, the oldest deltas are dropped first (they are ephemeral
	 * by design).
	 */
	#pushEvent(evt: LiveEvent): void {
		if (this.#eventLogLimit <= 0) return
		this.events.push(evt)
		if (this.events.length <= this.#eventLogLimit) return
		const overflow = this.events.length - this.#eventLogLimit
		const kept: LiveEvent[] = []
		let dropped = 0
		for (const e of this.events) {
			if (dropped < overflow && isDeltaEvent(e)) {
				dropped++
				continue
			}
			kept.push(e)
		}
		this.events = kept
	}

	/** Abort the SSE loop. Safe to call repeatedly. */
	dispose(): void {
		this.#abort?.abort()
		this.#abort = null
	}

	/** Drop all state and detach — ready for a fresh `attach()`. */
	reset(): void {
		this.dispose()
		this.id = null
		this.status = 'idle'
		this.stream = createStreamState()
		this.events = []
		this.error = null
		this.attached = Promise.resolve()
	}
}

/** Backwards-compatible alias for `GenerationStream` (see above). */
export const ButlerSession = GenerationStream
export type ButlerSession = GenerationStream
export type ButlerSessionOptions = GenerationStreamOptions
