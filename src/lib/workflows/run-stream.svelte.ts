/**
 * WorkflowRunStream — Svelte 5 runes wrapper around {@link AlfredClient}'s
 * run-stream methods (`plans/workflow-finalize.md` §6 S6).
 *
 * Run-scoped sibling of `GenerationStream` (`../alfred/session.svelte.ts`),
 * same lifecycle rules (never a module singleton; explicit attach/dispose;
 * `$effect` teardown at the call site). Pure viewer: it never POSTs
 * anything — no tick, no drive, just the SSE read loop over
 * `GET /wfstreams/{rid}` plus the `/poll` fallback (Decision 7: fallback
 * only, never in parallel).
 *
 * The wire event (`WorkflowRunEvent`: `{seq, type, payload}`) is converted
 * to the render shape (`WorkflowStreamEvent`: `{type, ...payload}`) on
 * ingest — the host publishes `{type, payload}` where `payload` is the
 * event minus its `type` (see `arb2b/.../workflows/alfred.ts`
 * `runEventPayload`), so spreading the payload back under its `type`
 * reconstructs the FE event. `lastSeq` tracks the run-local stream `seq`.
 *
 * ```svelte
 * <script lang="ts">
 *   import { AlfredClient, WorkflowRunStream } from '$lib'
 *   const runs = new WorkflowRunStream({ client: new AlfredClient({ baseUrl }) })
 *   $effect(() => () => runs.dispose())
 * </script>
 * {#each runs.events as e}<p>{e.type}</p>{/each}
 * ```
 *
 * Rules (same as `GenerationStream`):
 * - **Never a module-level singleton.** `$state` at module scope is shared
 *   across requests during SSR. Instantiate per component.
 * - **Explicit `attach()` / `dispose()`, not `$effect`.** Teardown is the
 *   caller's job (one `$effect(() => () => runs.dispose())` at the call site).
 * - **Client-safe:** no `node:` imports, no env reads.
 */

import { type AlfredClient, AlfredError } from '../alfred/client.js'
import type { WorkflowRunEvent, WorkflowRunStreamCredential } from '../alfred/types.js'
import type { WorkflowStreamEvent } from './types.js'

/**
 * Default cap on {@link WorkflowRunStream.events}. Runs emit tens of rows,
 * never the 10–100x deltas of a generation, so the cap is a safety valve
 * that is never hit in practice; beyond it the oldest events are dropped.
 */
export const DEFAULT_RUN_EVENT_LOG_LIMIT = 500

/** After this many consecutive SSE failures the `/poll` fallback engages once. */
export const RUN_STREAM_POLL_FALLBACK_AFTER = 2

/** Run lifecycle. `idle` = attached to nothing yet; the rest mirror `run_status`. */
export type WorkflowRunStatus = 'idle' | 'running' | 'waiting' | 'done' | 'error' | 'cancelled'

export interface WorkflowRunStreamOptions {
	/** The transport. Construct with `baseUrl` = the run `stream_url` base. */
	client: AlfredClient
	/**
	 * Max entries kept in {@link WorkflowRunStream.events}. Default
	 * {@link DEFAULT_RUN_EVENT_LOG_LIMIT}. Beyond it the oldest events are
	 * dropped first. `0` disables the log entirely (the cursor still advances).
	 */
	eventLogLimit?: number
	/**
	 * Re-mint the run-stream capability when Alfred answers `401` (expired)
	 * or `410` (run gone). Called at most once per failed attach; the
	 * returned credential is installed via
	 * {@link AlfredClient.setRunStreamCredential} and the attach is retried.
	 * The host's `play` endpoint is the source — the FE never mints.
	 */
	refreshStream?: () => Promise<WorkflowRunStreamCredential>
	/**
	 * Backoff between SSE reconnects, by 1-based attempt number. Default
	 * 1s → 5s cap (`min(1000 * 2^(n-1), 5000)`). Pass `() => 0` in tests.
	 */
	reconnectDelayMs?: (attempt: number) => number
	/**
	 * Consecutive SSE failures before the `/poll` fallback engages once.
	 * Default {@link RUN_STREAM_POLL_FALLBACK_AFTER}. Never polls in
	 * parallel with SSE — the fallback replaces the next SSE retry.
	 */
	pollFallbackAfter?: number
}

/** Default reconnect backoff: 1s, 2s, 4s, then the 5s cap. */
export function defaultRunReconnectDelay(attempt: number): number {
	return Math.min(1000 * 2 ** Math.max(attempt - 1, 0), 5000)
}

/**
 * Convert a wire run event (`{seq, type, payload}`) to the render shape
 * (`{type, ...payload}`). The host publishes `payload` as the event minus
 * its `type`, so this is the exact inverse of `runEventPayload`.
 */
export function toWorkflowStreamEvent(evt: WorkflowRunEvent): WorkflowStreamEvent {
	return { ...evt.payload, type: evt.type } as WorkflowStreamEvent
}

/** True for a terminal `run_status` (`done`/`error`/`cancelled`). */
export function isTerminalRunStatus(evt: WorkflowStreamEvent): boolean {
	return (
		evt.type === 'run_status' &&
		(evt as Extract<WorkflowStreamEvent, { type: 'run_status' }>).status !== 'running' &&
		(evt as Extract<WorkflowStreamEvent, { type: 'run_status' }>).status !== 'waiting'
	)
}

export class WorkflowRunStream {
	#client: AlfredClient
	#eventLogLimit: number
	#refreshStream: (() => Promise<WorkflowRunStreamCredential>) | undefined
	#reconnectDelayMs: (attempt: number) => number
	#pollFallbackAfter: number
	/** Reactive so {@link WorkflowRunStream.isStreaming} tracks attach/dispose. */
	#abort = $state<AbortController | null>(null)

	/** Server run id, `null` until `attach()`. */
	id = $state<string | null>(null)
	/** Lifecycle status, from the last `run_status` (`idle` before any). */
	status = $state<WorkflowRunStatus>('idle')
	/** Render-ready events (`WorkflowStreamEvent`), in arrival order. */
	events = $state<WorkflowStreamEvent[]>([])
	/** Highest run-local `seq` seen — the reconnect cursor. */
	lastSeq = $state<number>(0)
	/** Last transport/stream error message, cleared on the next attach. */
	error = $state<string | null>(null)
	/** Resolves when the current SSE loop ends. Await it in tests. */
	attached: Promise<void> = Promise.resolve()

	/**
	 * Whether the SSE loop is currently attached. Derived from the abort
	 * controller, not from `status`.
	 */
	readonly isStreaming = $derived(this.#abort !== null)

	constructor(opts: WorkflowRunStreamOptions) {
		this.#client = opts.client
		this.#eventLogLimit = opts.eventLogLimit ?? DEFAULT_RUN_EVENT_LOG_LIMIT
		this.#refreshStream = opts.refreshStream
		this.#reconnectDelayMs = opts.reconnectDelayMs ?? defaultRunReconnectDelay
		this.#pollFallbackAfter = opts.pollFallbackAfter ?? RUN_STREAM_POLL_FALLBACK_AFTER
	}

	/** The underlying transport (for calls this wrapper does not cover). */
	get client(): AlfredClient {
		return this.#client
	}

	/**
	 * Attach (or re-attach) the SSE loop for a run credential, replaying
	 * durable events since `afterSeq` (default: the current {@link lastSeq}
	 * cursor, so reconnects resume where they left off). Aborts any previous
	 * loop first. Returns a promise that resolves when the loop ends; also
	 * stored on {@link attached}.
	 *
	 * Attaching a NEW run id resets `events`/`lastSeq`/`status`; re-attaching
	 * the SAME run keeps them (replay dedup is the caller's job until S7).
	 * The credential type (`WorkflowRunStreamCredential`) is exported from
	 * the `alfred` barrel — this module imports it but does not re-export it
	 * (one export site, per the `FetchFn` collision rule).
	 */
	attach(
		credential: WorkflowRunStreamCredential | string | null = null,
		opts: { afterSeq?: number } = {}
	): Promise<void> {
		const rid = typeof credential === 'string' ? credential : (credential?.run_id ?? this.id)
		if (!rid) return Promise.reject(new AlfredError('no run id to attach', { code: 'validation' }))
		if (credential && typeof credential !== 'string') {
			this.#client.setRunStreamCredential(credential)
		}
		const isNewRun = this.id !== rid
		this.#abort?.abort()
		const ac = new AbortController()
		this.#abort = ac
		this.id = rid
		this.error = null
		if (isNewRun) {
			this.events = []
			this.lastSeq = opts.afterSeq ?? 0
			this.status = 'running'
		} else if (opts.afterSeq !== undefined) {
			this.lastSeq = opts.afterSeq
		}
		const run = this.#consume(rid, ac)
		this.attached = run
		return run
	}

	/**
	 * Consume the SSE generator, converting each wire event and folding it
	 * into reactive state. On transport error (not abort) reconnects from
	 * {@link lastSeq} with backoff; after `pollFallbackAfter` consecutive
	 * failures the `/poll` fallback replaces the next SSE retry (once —
	 * never in parallel with SSE). A terminal `run_status` ends the loop;
	 * the server also closes the stream, so the `for await` ends naturally.
	 */
	async #consume(rid: string, ac: AbortController): Promise<void> {
		let failures = 0
		try {
			while (!ac.signal.aborted) {
				try {
					await this.#withStream(async () => {
						for await (const evt of this.#client.streamWorkflowEvents(
							rid,
							this.lastSeq,
							ac.signal
						)) {
							if (ac.signal.aborted) return
							this.#ingest(evt)
							failures = 0
							if (this.status === 'done' || this.status === 'error' || this.status === 'cancelled')
								return
						}
					})
					return
				} catch {
					if (ac.signal.aborted) return
					failures++
					if (failures >= this.#pollFallbackAfter) {
						try {
							const res = await this.#client.pollWorkflowEvents(
								rid,
								this.lastSeq,
								undefined,
								ac.signal
							)
							for (const evt of res.events) {
								if (ac.signal.aborted) return
								this.#ingest(evt)
							}
						} catch (pollErr) {
							if (!ac.signal.aborted) {
								this.error = pollErr instanceof Error ? pollErr.message : String(pollErr)
								this.status = 'error'
							}
						}
						return
					}
					const delay = this.#reconnectDelayMs(failures)
					if (delay > 0) await new Promise((r) => setTimeout(r, delay))
				}
			}
		} finally {
			if (this.#abort === ac) this.#abort = null
		}
	}

	/**
	 * Run `fn`, refreshing the run-stream capability and retrying once on
	 * `401`/`410`. Without {@link WorkflowRunStreamOptions.refreshStream} the
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
			this.#client.setRunStreamCredential(credential)
			if (credential.run_id !== this.id) {
				this.id = credential.run_id
				return await fn()
			}
			return await fn()
		}
	}

	/** Fold one wire event into `events` + `lastSeq`, and sync `status`. */
	#ingest(evt: WorkflowRunEvent): void {
		if (typeof evt.seq === 'number') this.lastSeq = Math.max(this.lastSeq, evt.seq)
		const converted = toWorkflowStreamEvent(evt)
		this.#pushEvent(converted)
		if (converted.type === 'run_status') {
			this.status = (converted as Extract<WorkflowStreamEvent, { type: 'run_status' }>).status
		} else if (this.status === 'idle') {
			this.status = 'running'
		}
	}

	/**
	 * Append to the bounded event log. Runs emit tens of rows, so the cap is
	 * a safety valve only; beyond it the oldest events are dropped first.
	 */
	#pushEvent(evt: WorkflowStreamEvent): void {
		if (this.#eventLogLimit <= 0) return
		this.events.push(evt)
		if (this.events.length > this.#eventLogLimit) {
			this.events = this.events.slice(this.events.length - this.#eventLogLimit)
		}
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
		this.events = []
		this.lastSeq = 0
		this.error = null
		this.attached = Promise.resolve()
	}
}
