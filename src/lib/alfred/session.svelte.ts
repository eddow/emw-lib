/**
 * ButlerSession — Svelte 5 runes wrapper around {@link AlfredClient}.
 *
 * The pure core (`types.ts`, `client.ts`, `stream.ts`) stays framework-free;
 * this module is the one Svelte-aware layer on top. It owns the lifecycle a
 * consumer would otherwise wire by hand: create/attach, the SSE loop, the
 * reconnect cursor, and the reactive state a component renders.
 *
 * ```svelte
 * <script lang="ts">
 *   import { AlfredClient, ButlerSession } from '$lib'
 *   const session = new ButlerSession({ client: new AlfredClient({ baseUrl }) })
 *   $effect(() => () => session.dispose())
 * </script>
 * <p>{session.text}</p>
 * ```
 *
 * Rules:
 * - **Never a module-level singleton.** `$state` at module scope is shared
 *   across requests during SSR and would leak one session into another's
 *   render. Instantiate per component (or via `setContext`).
 * - **Explicit `attach()` / `dispose()`, not `$effect`.** `$effect` only runs
 *   inside a component or an effect root, so a class built in a plain module
 *   or a test would silently never subscribe. Teardown is the caller's job
 *   (one `$effect(() => () => session.dispose())` at the call site).
 * - **Reuse {@link applyLiveEvent}.** The reducer is already unit-tested for
 *   the delta/final/cursor rules; this class is a lifecycle shell over it,
 *   never a second implementation.
 */

import { type AlfredClient, AlfredError } from './client.js'
import { applyLiveEvent, createStreamState, isDeltaEvent, type StreamState } from './stream.js'
import type { AlfredCredential, CreateSessionInput, HistoryItem, LiveEvent } from './types.js'

/**
 * Default cap on {@link ButlerSession.events}. Deltas are 10–100x the finals
 * (`butler/alfred.md` §4.1), so an uncapped log grows without bound on a long
 * session. Durable events are never dropped; only deltas are trimmed.
 */
export const DEFAULT_EVENT_LOG_LIMIT = 500

/** Session lifecycle, mirroring the server's `status` plus a client-only `streaming`. */
export type ButlerStatus = 'idle' | 'running' | 'streaming' | 'paused' | 'done' | 'error'

/**
 * How a prompt reaches a running agent (`butler/alfred.md` §5):
 * - `queue` — waits for `done` (server restarts a finished/paused loop).
 * - `steer` — next iteration boundary only, never aborts in-flight work.
 * - `redirect` — aborts in-flight generation, injects immediately, resumes.
 */
export type SendMode = 'queue' | 'steer' | 'redirect'

export interface ButlerSessionOptions {
	/** The transport. Construct with `baseUrl: env.BUTLER_URL` in `emw`. */
	client: AlfredClient
	/** Auto-attach the SSE loop on `create()` / `resume()`. Default `true`. */
	autoStream?: boolean
	/**
	 * Max entries kept in {@link ButlerSession.events}. Default
	 * {@link DEFAULT_EVENT_LOG_LIMIT}. Durable events are always kept; only
	 * deltas are trimmed, oldest first. `0` disables the log entirely.
	 */
	eventLogLimit?: number
	/**
	 * Re-mint the bearer token when Alfred answers `401` (expired, 1h TTL).
	 * Called at most once per failed request; the returned credential is
	 * installed on the client via {@link AlfredClient.setCredential} (token
	 * AND base URL travel together — see {@link AlfredCredential}) and the
	 * request is retried, so the expiry is invisible to the user. Omit it
	 * when the client authenticates with `X-Alfred-Secret` (server-side) or
	 * when the token cannot expire within the session's lifetime.
	 */
	refreshToken?: () => Promise<string | AlfredCredential>
}

export class ButlerSession {
	#client: AlfredClient
	#autoStream: boolean
	#eventLogLimit: number
	#refreshToken: (() => Promise<string | AlfredCredential>) | undefined
	/** Reactive so {@link isStreaming} tracks attach/dispose. */
	#abort = $state<AbortController | null>(null)

	/** Server session id, `null` until `create()` / `attach()`. */
	id = $state<string | null>(null)
	/** Lifecycle status. */
	status = $state<ButlerStatus>('idle')
	/** Live drafts + reconnect cursor, reduced by {@link applyLiveEvent}. */
	stream = $state<StreamState>(createStreamState())
	/**
	 * Recent live events (durable + deltas), in order. Bounded by
	 * {@link ButlerSessionOptions.eventLogLimit}: durable events are always
	 * kept, deltas are trimmed oldest-first. For the full durable record use
	 * {@link loadHistory}.
	 */
	events = $state<LiveEvent[]>([])
	/** Durable history loaded via {@link loadHistory} (messages + events). */
	history = $state<HistoryItem[]>([])
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
	/**
	 * Whether the SSE loop is currently attached. Derived from the abort
	 * controller, not from `status`: `stop()` pauses the agent while the
	 * connection stays open, so `status === 'streaming'` would under-report.
	 */
	readonly isStreaming = $derived(this.#abort !== null)

	constructor(opts: ButlerSessionOptions) {
		this.#client = opts.client
		this.#autoStream = opts.autoStream ?? true
		this.#eventLogLimit = opts.eventLogLimit ?? DEFAULT_EVENT_LOG_LIMIT
		this.#refreshToken = opts.refreshToken
	}

	/** The underlying transport (for calls this wrapper does not cover). */
	get client(): AlfredClient {
		return this.#client
	}

	/** `POST /sessions`, then attach the stream. Returns the new session id. */
	async create(input: CreateSessionInput): Promise<string> {
		this.reset()
		const { session_id } = await this.#client.createSession(input)
		this.id = session_id
		this.status = 'running'
		if (this.#autoStream) void this.attach(session_id)
		return session_id
	}

	/**
	 * Attach (or re-attach) the SSE loop, replaying durable events since
	 * {@link lastSeq}. Aborts any previous loop first. Returns a promise that
	 * resolves when the loop ends; also stored on {@link attached}.
	 */
	attach(sid: string | null = this.id): Promise<void> {
		if (!sid)
			return Promise.reject(new AlfredError('no session id to attach', { code: 'validation' }))
		this.#abort?.abort()
		const ac = new AbortController()
		this.#abort = ac
		this.id = sid
		this.status = 'streaming'
		this.error = null
		const run = this.#consume(sid, ac)
		this.attached = run
		return run
	}

	/** Consume the SSE generator, reducing each event into reactive state. */
	async #consume(sid: string, ac: AbortController): Promise<void> {
		try {
			await this.#withAuth(async () => {
				for await (const evt of this.#client.events(sid, this.stream.lastSeq, ac.signal)) {
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
	 * Run `fn`, re-minting the credential and retrying once on `401`. Without a
	 * {@link ButlerSessionOptions.refreshToken} the error propagates unchanged.
	 */
	async #withAuth<T>(fn: () => Promise<T>): Promise<T> {
		try {
			return await fn()
		} catch (err) {
			if (!this.#refreshToken || !(err instanceof AlfredError) || err.status !== 401) throw err
			const credential = await this.#refreshToken()
			if (typeof credential === 'string') this.#client.setAuthToken(credential)
			else this.#client.setCredential(credential)
			return await fn()
		}
	}

	/** Fold one live event into `stream` + `events`, and sync `status`. */
	#ingest(evt: LiveEvent): void {
		this.stream = applyLiveEvent(this.stream, evt)
		this.#pushEvent(evt)
		if (this.stream.status === 'done') this.status = 'done'
		else if (this.stream.status === 'error') this.status = 'error'
		else this.status = 'streaming'
	}

	/**
	 * Append to the bounded event log. Durable events are always kept; when the
	 * cap is exceeded, the oldest deltas are dropped first (they are ephemeral
	 * by design — `butler/alfred.md` §4.1).
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

	/** Send a prompt to the running agent. See {@link SendMode}. */
	async send(prompt: string, mode: SendMode = 'queue'): Promise<void> {
		const sid = this.#requireId()
		this.error = null
		await this.#withAuth(async () => {
			if (mode === 'steer') await this.#client.steer(sid, prompt)
			else if (mode === 'redirect') await this.#client.redirect(sid, prompt)
			else await this.#client.queue(sid, prompt)
		})
		// The SSE loop survives turns; only re-attach if it had ended.
		if (this.#autoStream && !this.#abort) void this.attach(sid)
	}

	/** Pause the loop, keeping state. */
	async stop(): Promise<void> {
		const sid = this.#requireId()
		await this.#withAuth(() => this.#client.stop(sid))
		this.status = 'paused'
	}

	/** Resume a paused loop, re-attaching the stream if needed. */
	async resume(): Promise<void> {
		const sid = this.#requireId()
		await this.#withAuth(() => this.#client.resume(sid))
		this.status = 'running'
		if (this.#autoStream && !this.#abort) void this.attach(sid)
	}

	/**
	 * Load durable history (messages + events, no deltas) into {@link history}.
	 *
	 * Also advances the reconnect cursor to the highest *event* `seq` seen, so
	 * a later {@link attach} resumes *after* what history already showed
	 * instead of replaying it. Message `seq`s live in an independent space
	 * (`butler/alfred.md` §6 — `messages.seq` vs `events.seq`) and must never
	 * move the event cursor, else `attach` would skip durable events. Pass
	 * `afterSeq` to page older history without moving the cursor backwards.
	 */
	async loadHistory(afterSeq = 0): Promise<void> {
		const sid = this.#requireId()
		const { events } = await this.#withAuth(() => this.#client.history(sid, afterSeq))
		this.history = events
		const maxSeq = events.reduce(
			(max, item) => (item.kind === 'event' ? Math.max(max, item.seq) : max),
			0
		)
		if (maxSeq > this.stream.lastSeq) this.stream = { ...this.stream, lastSeq: maxSeq }
	}

	/** Abort the SSE loop. Safe to call repeatedly. */
	dispose(): void {
		this.#abort?.abort()
		this.#abort = null
	}

	/** Drop all state and detach — ready for a fresh `create()`. */
	reset(): void {
		this.dispose()
		this.id = null
		this.status = 'idle'
		this.stream = createStreamState()
		this.events = []
		this.history = []
		this.error = null
		this.attached = Promise.resolve()
	}

	/** Throw a validation error when no session is attached yet. */
	#requireId(): string {
		if (!this.id)
			throw new AlfredError('session has no id — call create() or attach() first', {
				code: 'validation',
			})
		return this.id
	}
}
