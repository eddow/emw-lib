/**
 * Alfred HTTP client — transport for the Butler (`butler/alfred.md`).
 *
 * Framework-agnostic: no Svelte, no `node:` imports, no env reads. All network
 * I/O goes through an injectable {@link FetchFn} (defaults to global `fetch`)
 * so tests can pass a mock and never touch a live OpenRouter.
 *
 * Every failure — transport, non-2xx, timeout, validation — surfaces as an
 * {@link AlfredError}; callers never see a raw `Response`.
 */

import type {
	AlfredCredential,
	CreateSessionInput,
	FetchFn,
	HistoryItem,
	LiveEvent,
	PollResponse,
	SessionInfo,
	SessionSummary,
} from './types.js'

/**
 * Default base URL of the Butler service, used when no `baseUrl` is passed.
 *
 * Two callers, two URLs — both resolved by `emw` (this lib stays env-free):
 * - **Server-side control** (`emw` → Alfred): `env.BUTLER_URL`, private.
 * - **Browser stream** (SSE): `env.ALFRED_PUBLIC_URL`, handed to the client
 *   alongside the minted token. Alfred is reachable directly; the token, not
 *   the host, is the secret.
 */
export const ALFRED_DEFAULT_BASE_URL = 'http://localhost:8192'

/** Default per-request timeout (ms) when no `signal` is supplied. */
export const ALFRED_DEFAULT_TIMEOUT_MS = 30_000

/** Max accepted prompt length, mirroring the server's validation. */
export const ALFRED_MAX_PROMPT = 4000

export interface AlfredClientOptions {
	/**
	 * Base URL of the Butler. Defaults to {@link ALFRED_DEFAULT_BASE_URL}.
	 * Server-side control uses `env.BUTLER_URL`; the browser uses
	 * `env.ALFRED_PUBLIC_URL`. Trailing slashes trimmed.
	 */
	baseUrl?: string
	/**
	 * Per-session bearer token (`butler/alfred.md` §7.1). When set, every
	 * request carries `Authorization: Bearer <token>`. Server-side callers
	 * leave it unset and authenticate with `X-Alfred-Secret` instead.
	 */
	authToken?: string
	/** Injectable fetch, default global `fetch`. */
	fetchFn?: FetchFn
	/** Default timeout in ms, default {@link ALFRED_DEFAULT_TIMEOUT_MS}. A per-call `signal` wins. */
	defaultTimeoutMs?: number
}

/** Single error type for the whole client. */
export class AlfredError extends Error {
	/** HTTP status when the failure came from a response. */
	status?: number
	/** Machine-readable code: `validation` | `http` | `timeout` | `aborted` | `network` | `parse`. */
	code: string
	/** Server-provided detail (parsed body when available). */
	detail?: unknown

	constructor(
		message: string,
		opts: { status?: number; code: string; detail?: unknown } = { code: 'network' }
	) {
		super(message)
		this.name = 'AlfredError'
		this.status = opts.status
		this.code = opts.code
		this.detail = opts.detail
	}
}

/** Throw a validation error before any network call. */
function invalid(message: string): never {
	throw new AlfredError(message, { code: 'validation' })
}

/** `sid` must be a non-empty string. */
function assertSid(sid: string): void {
	if (typeof sid !== 'string' || sid.trim() === '') invalid('sid must be a non-empty string')
}

/** `prompt` must be 1..{@link ALFRED_MAX_PROMPT} chars. */
function assertPrompt(prompt: string): void {
	if (typeof prompt !== 'string' || prompt.length < 1 || prompt.length > ALFRED_MAX_PROMPT)
		invalid(`prompt must be 1..${ALFRED_MAX_PROMPT} chars`)
}

/** `after_seq` must be an integer >= 0. */
function assertAfterSeq(afterSeq: number): void {
	if (!Number.isInteger(afterSeq) || afterSeq < 0) invalid('after_seq must be an integer >= 0')
}

/** Clamp `timeout_s` to 0..60 (default 25, matching the server). */
function clampTimeout(timeoutS: number | undefined): number {
	if (timeoutS === undefined) return 25
	if (typeof timeoutS !== 'number' || Number.isNaN(timeoutS)) invalid('timeout_s must be a number')
	return Math.min(Math.max(timeoutS, 0), 60)
}

/** Drop `undefined` keys so we never send `{"prompt": undefined}`. */
function compact<T extends Record<string, unknown>>(obj: T): Record<string, unknown> {
	const out: Record<string, unknown> = {}
	for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v
	return out
}

/** Extract the `data:` payload of one SSE block; `null` when it carries none. */
function sseData(block: string): string | null {
	const lines: string[] = []
	for (const raw of block.split('\n')) {
		if (raw === '' || raw.startsWith(':')) continue // comment / heartbeat
		if (!raw.startsWith('data:')) continue
		lines.push(raw.slice(5).replace(/^ /, ''))
	}
	return lines.length ? lines.join('\n') : null
}

/**
 * Parse an SSE byte stream into JSON payloads. Skips comments/heartbeats and
 * `data: [DONE]`; silently drops malformed JSON frames.
 */
async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
	const reader = body.getReader()
	const decoder = new TextDecoder()
	let buffer = ''
	try {
		while (true) {
			const { done, value } = await reader.read()
			if (done) break
			buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n')
			let idx = buffer.indexOf('\n\n')
			while (idx !== -1) {
				const block = buffer.slice(0, idx)
				buffer = buffer.slice(idx + 2)
				const data = sseData(block)
				if (data !== null && data !== '[DONE]') {
					try {
						yield JSON.parse(data)
					} catch {
						// malformed frame — skip, keep the stream alive
					}
				}
				idx = buffer.indexOf('\n\n')
			}
		}
	} finally {
		reader.releaseLock()
	}
}

/** Highest durable `seq` in a batch, or `null` when the batch is pure deltas. */
function maxDurableSeq(events: LiveEvent[]): number | null {
	let max: number | null = null
	for (const e of events) {
		if (typeof e.seq === 'number' && (max === null || e.seq > max)) max = e.seq
	}
	return max
}

export class AlfredClient {
	private baseUrl: string
	private readonly fetchFn: FetchFn
	private readonly defaultTimeoutMs: number
	private authToken: string | undefined

	constructor(opts: AlfredClientOptions = {}) {
		this.baseUrl = (opts.baseUrl ?? ALFRED_DEFAULT_BASE_URL).replace(/\/+$/, '')
		this.fetchFn = opts.fetchFn ?? fetch
		this.defaultTimeoutMs = opts.defaultTimeoutMs ?? ALFRED_DEFAULT_TIMEOUT_MS
		this.authToken = opts.authToken
	}

	/**
	 * Replace the bearer token used for subsequent requests. Called by
	 * {@link ButlerSession} after a refresh; `undefined` clears it.
	 */
	setAuthToken(token: string | undefined): void {
		this.authToken = token
	}

	/**
	 * Install a credential as served by `emw`'s token route
	 * (`{ token, expires_at, base_url }`): swaps the bearer token AND the
	 * base URL in one step, so the browser never hardcodes a host. An empty
	 * or missing `base_url` keeps the current URL.
	 */
	setCredential(credential: AlfredCredential): void {
		if (!credential?.token) invalid('credential.token is required')
		this.authToken = credential.token
		const baseUrl = credential.base_url?.trim()
		if (baseUrl) this.baseUrl = baseUrl.replace(/\/+$/, '')
	}

	// -- sessions ---------------------------------------------------------

	/** `POST /sessions` → `{ session_id }`. */
	async createSession(
		input: CreateSessionInput,
		signal?: AbortSignal
	): Promise<{ session_id: string }> {
		if (!input?.agent?.model) invalid('agent.model is required')
		const body = compact({
			agent: input.agent,
			toolset: input.toolset,
			initial_prompt: input.initial_prompt,
			metadata: input.metadata,
		})
		return this.json('POST', '/sessions', body, signal)
	}

	/** `GET /sessions` → `{ sessions }` (summaries — no `agent`/`toolset`). */
	async listSessions(signal?: AbortSignal): Promise<{ sessions: SessionSummary[] }> {
		return this.json('GET', '/sessions', undefined, signal)
	}

	/** `GET /sessions/{sid}` → session info. */
	async getSession(sid: string, signal?: AbortSignal): Promise<SessionInfo> {
		assertSid(sid)
		return this.json('GET', `/sessions/${encodeURIComponent(sid)}`, undefined, signal)
	}

	/** `DELETE /sessions/{sid}` → `{ ok: true }`. */
	async deleteSession(sid: string, signal?: AbortSignal): Promise<{ ok: true }> {
		assertSid(sid)
		return this.json('DELETE', `/sessions/${encodeURIComponent(sid)}`, undefined, signal)
	}

	// -- history / poll ---------------------------------------------------

	/** `GET /sessions/{sid}/history` → durable messages + events (never deltas). */
	async history(
		sid: string,
		afterSeq = 0,
		type?: string,
		signal?: AbortSignal
	): Promise<{ events: HistoryItem[] }> {
		assertSid(sid)
		assertAfterSeq(afterSeq)
		const params = new URLSearchParams({ after_seq: String(afterSeq) })
		if (type) params.set('type', type)
		return this.json(
			'GET',
			`/sessions/${encodeURIComponent(sid)}/history?${params}`,
			undefined,
			signal
		)
	}

	/** `GET /sessions/{sid}/poll` → durable replay + live deltas, or `{ timeout: true }`. */
	async poll(
		sid: string,
		afterSeq = 0,
		timeoutS?: number,
		signal?: AbortSignal
	): Promise<PollResponse> {
		assertSid(sid)
		assertAfterSeq(afterSeq)
		const clamped = clampTimeout(timeoutS)
		const params = new URLSearchParams({
			after_seq: String(afterSeq),
			timeout_s: String(clamped),
		})
		// The server holds the request for `timeout_s` (up to 60s), so the
		// client timeout must cover it — otherwise a long poll always dies
		// first with a spurious `timeout` error. A caller `signal` still wins.
		const timeoutMs =
			signal === undefined ? Math.max(this.defaultTimeoutMs, (clamped + 5) * 1000) : undefined
		return this.json(
			'GET',
			`/sessions/${encodeURIComponent(sid)}/poll?${params}`,
			undefined,
			signal,
			timeoutMs
		)
	}

	// -- control ----------------------------------------------------------

	/** `POST /sessions/{sid}/stop` → pause the loop, keep state. */
	async stop(sid: string, signal?: AbortSignal): Promise<{ ok: true; status: string }> {
		assertSid(sid)
		return this.json('POST', `/sessions/${encodeURIComponent(sid)}/stop`, undefined, signal)
	}

	/** `POST /sessions/{sid}/resume` → resume a paused loop. */
	async resume(sid: string, signal?: AbortSignal): Promise<{ ok: true; status: string }> {
		assertSid(sid)
		return this.json('POST', `/sessions/${encodeURIComponent(sid)}/resume`, undefined, signal)
	}

	/** `POST /sessions/{sid}/queue` → append a user message for when the agent is done. */
	async queue(sid: string, prompt: string, signal?: AbortSignal): Promise<{ ok: true }> {
		assertSid(sid)
		assertPrompt(prompt)
		return this.json('POST', `/sessions/${encodeURIComponent(sid)}/queue`, { prompt }, signal)
	}

	/** `POST /sessions/{sid}/steer` → inject at the next iteration boundary. */
	async steer(sid: string, prompt: string, signal?: AbortSignal): Promise<{ ok: true }> {
		assertSid(sid)
		assertPrompt(prompt)
		return this.json('POST', `/sessions/${encodeURIComponent(sid)}/steer`, { prompt }, signal)
	}

	/** `POST /sessions/{sid}/redirect` → abort in-flight, inject immediately, resume. */
	async redirect(sid: string, prompt: string, signal?: AbortSignal): Promise<{ ok: true }> {
		assertSid(sid)
		assertPrompt(prompt)
		return this.json('POST', `/sessions/${encodeURIComponent(sid)}/redirect`, { prompt }, signal)
	}

	/** `POST /sessions/{sid}/tool-callback` → resume a loop paused on a `callback` tool. */
	async toolCallback(
		sid: string,
		body: { tool_call_id: string; result?: unknown; error?: unknown },
		signal?: AbortSignal
	): Promise<{ ok: true }> {
		assertSid(sid)
		if (!body?.tool_call_id) invalid('tool_call_id is required')
		return this.json(
			'POST',
			`/sessions/${encodeURIComponent(sid)}/tool-callback`,
			compact({ tool_call_id: body.tool_call_id, result: body.result, error: body.error }),
			signal
		)
	}

	/** `POST /sessions/{sid}/backup` → `{ ok: true, path }`. */
	async backup(sid: string, signal?: AbortSignal): Promise<{ ok: true; path: string }> {
		assertSid(sid)
		return this.json('POST', `/sessions/${encodeURIComponent(sid)}/backup`, undefined, signal)
	}

	/**
	 * `POST /sessions/{sid}/token` → `{ token, expires_at }`.
	 *
	 * Mints the browser's bearer token (`butler/alfred.md` §7.1). Server-side
	 * only: the caller must hold `X-Alfred-Secret`, so this is `emw`'s job, not
	 * the browser's. The token is scoped to `sid` and expires after
	 * `ALFRED_TOKEN_TTL_S` (default 1h).
	 */
	async mintToken(
		sid: string,
		signal?: AbortSignal
	): Promise<{ token: string; expires_at: string }> {
		assertSid(sid)
		return this.json('POST', `/sessions/${encodeURIComponent(sid)}/token`, undefined, signal)
	}

	/**
	 * `POST /sessions/{sid}/tool-callback/expire` → `{ ok: true, expired }`.
	 *
	 * Resolves overdue `callback` calls as `is_error` tool results so a lost
	 * callback cannot wedge the session in `waiting_callback` forever
	 * (`butler/alfred.md` §2.1.1). Alfred schedules this itself; the endpoint
	 * is for a manual/forced sweep.
	 */
	async expireCallbacks(sid: string, signal?: AbortSignal): Promise<{ ok: true; expired: number }> {
		assertSid(sid)
		return this.json(
			'POST',
			`/sessions/${encodeURIComponent(sid)}/tool-callback/expire`,
			undefined,
			signal
		)
	}

	/** `GET /health` → `{ ok: true }`. */
	async health(signal?: AbortSignal): Promise<{ ok: true }> {
		return this.json('GET', '/health', undefined, signal)
	}

	// -- streaming --------------------------------------------------------

	/**
	 * `GET /sessions/{sid}/events` (SSE). Replays durable events since
	 * `after_seq`, then yields live durable events and ephemeral deltas until
	 * `signal` aborts. Uses `fetchFn` + a stream reader (not `EventSource`) so
	 * headers and a mock fetch work in tests.
	 */
	async *events(
		sid: string,
		afterSeq = 0,
		signal?: AbortSignal
	): AsyncGenerator<LiveEvent, void, void> {
		assertSid(sid)
		assertAfterSeq(afterSeq)
		const params = new URLSearchParams({ after_seq: String(afterSeq) })
		const url = `${this.baseUrl}/sessions/${encodeURIComponent(sid)}/events?${params}`
		// SSE is a long-lived stream: never apply the implicit per-request
		// timeout. Without a caller `signal` the loop runs until `dispose()`;
		// with one, the caller's abort is the only deadline.
		const res = await this.send(
			url,
			{ method: 'GET', headers: { accept: 'text/event-stream' } },
			signal,
			null
		)
		if (!res.ok) throw await this.httpError(res)
		if (!res.body) throw new AlfredError('SSE response has no body', { code: 'parse' })
		for await (const frame of parseSse(res.body)) yield frame as LiveEvent
	}

	/**
	 * Long-poll fallback for clients that cannot hold SSE. Yields events and
	 * advances the durable cursor; returns (does not throw) on `{ timeout: true }`.
	 */
	async *pollLoop(
		sid: string,
		opts: { after_seq?: number; timeout_s?: number; signal?: AbortSignal } = {}
	): AsyncGenerator<LiveEvent, void, void> {
		assertSid(sid)
		let cursor = opts.after_seq ?? 0
		assertAfterSeq(cursor)
		while (!opts.signal?.aborted) {
			const res = await this.poll(sid, cursor, opts.timeout_s, opts.signal)
			for (const evt of res.events) yield evt
			const max = maxDurableSeq(res.events)
			if (max !== null) cursor = max + 1
			if (res.timeout) return
		}
	}

	// -- internals --------------------------------------------------------

	/** Perform a fetch with timeout/abort handling, mapping failures to {@link AlfredError}. */
	private async send(
		url: string,
		init: RequestInit,
		signal?: AbortSignal,
		timeoutMs?: number | null
	): Promise<Response> {
		let controller: AbortController | undefined
		let timer: ReturnType<typeof setTimeout> | undefined
		let timedOut = false
		// `timeoutMs === null` means "no implicit timeout" (SSE streams).
		// A caller-supplied signal always wins over any timeout.
		const effectiveTimeout =
			signal || timeoutMs === null ? undefined : (timeoutMs ?? this.defaultTimeoutMs)
		if (effectiveTimeout !== undefined) {
			controller = new AbortController()
			const ms = effectiveTimeout
			timer = setTimeout(() => {
				timedOut = true
				controller?.abort()
			}, ms)
		}
		const headers = new Headers(init.headers)
		if (this.authToken) headers.set('authorization', `Bearer ${this.authToken}`)
		try {
			return await this.fetchFn(url, {
				...init,
				headers,
				signal: signal ?? controller?.signal,
			})
		} catch (err) {
			if (timedOut)
				throw new AlfredError(
					`request timed out after ${effectiveTimeout ?? this.defaultTimeoutMs}ms`,
					{ code: 'timeout' }
				)
			if (signal?.aborted) throw new AlfredError('request aborted', { code: 'aborted' })
			throw new AlfredError(`network error: ${(err as Error).message}`, {
				code: 'network',
				detail: err,
			})
		} finally {
			if (timer) clearTimeout(timer)
		}
	}

	/** Build an {@link AlfredError} from a non-2xx response, reading its body when possible. */
	private async httpError(res: Response): Promise<AlfredError> {
		let detail: unknown
		try {
			const text = await res.text()
			detail = text ? JSON.parse(text) : undefined
		} catch {
			detail = undefined
		}
		const message =
			(detail && typeof detail === 'object' && 'detail' in detail
				? String((detail as { detail: unknown }).detail)
				: undefined) ?? `HTTP ${res.status} ${res.statusText}`
		return new AlfredError(message, { status: res.status, code: 'http', detail })
	}

	/** JSON request helper: send, check status, parse body. */
	private async json<T>(
		method: string,
		path: string,
		body: Record<string, unknown> | undefined,
		signal?: AbortSignal,
		timeoutMs?: number | null
	): Promise<T> {
		const init: RequestInit = { method }
		if (body !== undefined) {
			init.headers = { 'content-type': 'application/json' }
			init.body = JSON.stringify(body)
		}
		const res = await this.send(`${this.baseUrl}${path}`, init, signal, timeoutMs)
		if (!res.ok) throw await this.httpError(res)
		if (res.status === 204) return undefined as T
		try {
			return (await res.json()) as T
		} catch (err) {
			throw new AlfredError(`invalid JSON response: ${(err as Error).message}`, { code: 'parse' })
		}
	}
}
