/**
 * Alfred HTTP client — transport for the Butler (`butler/docs/alfred.md`).
 *
 * The client splits into
 * **BE methods** (secret: createSession, prompt, play, stop/resume/queue/
 * steer/interrupt, getSession/listSessions/deleteSession, history, backup,
 * wfrun register/play/publish)
 * and **stream methods** (token: streamEvents, streamPoll, run streamEvents,
 * run streamPoll). Session-scoped
 * authToken / setCredential / mintToken / events(sid) / poll(sid) /
 * toolCallback / expireCallbacks are deleted.
 *
 * Framework-agnostic: no Svelte, no `node:` imports, no env reads. All network
 * I/O goes through an injectable {@link FetchFn} (defaults to global `fetch`)
 * so tests can pass a mock and never touch a live OpenRouter.
 *
 * Every failure — transport, non-2xx, timeout, validation — surfaces as an
 * {@link AlfredError}; callers never see a raw `Response`.
 */

import type {
	AskHumanResult,
	CreateSessionInput,
	FetchFn,
	HistoryItem,
	HumanAnswerInput,
	HumanPending,
	LiveEvent,
	PlayResult,
	PlayWorkflowRunResult,
	PollResponse,
	PromptInput,
	PromptResult,
	RegisterWorkflowRunResult,
	SessionInfo,
	SessionSummary,
	StreamCredential,
	ToolCallInput,
	ToolCallResult,
	ToolDef,
	WorkflowRunEvent,
	WorkflowRunEventInput,
	WorkflowRunPollResponse,
	WorkflowRunStreamCredential,
} from './types.js'

/**
 * Default base URL of the Butler service, used when no `baseUrl` is passed.
 *
 * Two callers, two URLs — both resolved by `emw` (this lib stays env-free):
 * - **Server-side control** (`emw` → Alfred): `env.BUTLER_URL`, private.
 * - **Browser stream** (SSE): `env.ALFRED_PUBLIC_URL`, handed to the FE as
 *   `stream_url` alongside the stream token. Alfred is reachable directly;
 *   the token, not the host, is the secret.
 */
export const ALFRED_DEFAULT_BASE_URL = 'http://localhost:8192'

/** Default per-request timeout (ms) when no `signal` is supplied. */
export const ALFRED_DEFAULT_TIMEOUT_MS = 30_000

/** `prompt` must be a non-empty string (no upper bound — Alfred stores it as-is). */
function assertPrompt(prompt: string): void {
	if (typeof prompt !== 'string' || prompt.length < 1) invalid('prompt must be non-empty')
}

export interface AlfredClientOptions {
	/**
	 * Base URL of the Butler. Defaults to {@link ALFRED_DEFAULT_BASE_URL}.
	 * Server-side control uses `env.BUTLER_URL`; the browser stream uses
	 * `env.ALFRED_PUBLIC_URL` (via `stream_url`). Trailing slashes trimmed.
	 */
	baseUrl?: string
	/**
	 * Shared secret for the BE control plane (see `butler/docs/alfred.md` §7).
	 * When set, every BE call carries `X-Alfred-Secret`. The browser never
	 * holds the secret — it uses `streamToken` instead. Empty = no header
	 * (local dev, mirroring Butler's skipped check).
	 */
	webhookSecret?: string
	/**
	 * Generation stream capability (see `butler/docs/alfred.md` §7.1). When set,
	 * stream calls carry it as `Authorization: Bearer <token>` (fetch-reader
	 * primary; `?stream_token=` / `X-Stream-Token` are server-accepted
	 * aliases the client never needs to use).
	 */
	streamToken?: string
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

/** `rid` must be a non-empty string. */
function assertRid(rid: string): void {
	if (typeof rid !== 'string' || rid.trim() === '') invalid('rid must be a non-empty string')
}

/** `gid` must be a non-empty string. */
function assertGid(gid: string): void {
	if (typeof gid !== 'string' || gid.trim() === '') invalid('gid must be a non-empty string')
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

/**
 * Render a FastAPI error body as a human-readable message. FastAPI sends
 * `{"detail": "string"}` for `HTTPException` but `{"detail": [...]}` (a
 * per-field error list) for 422 request-validation failures — `String()`
 * on the latter yields `[object Object],[object Object]`. Each entry is
 * rendered as `<loc>: <msg> (got <input>)`, joined with `; `. A dict detail
 * (e.g. the 409 conflict `{error, active_generation_id}`) renders its
 * `error`/`message`/`msg` field when present, else the raw JSON.
 */
export function formatDetail(detail: unknown): string | undefined {
	if (!detail || typeof detail !== 'object' || !('detail' in detail)) return undefined
	const raw = (detail as { detail: unknown }).detail
	if (typeof raw === 'string') return raw
	if (Array.isArray(raw)) {
		const parts = raw.map((entry) => {
			if (!entry || typeof entry !== 'object') return String(entry)
			const { loc, msg, input } = entry as { loc?: unknown; msg?: unknown; input?: unknown }
			const where = Array.isArray(loc) ? loc.map(String).join('.') : undefined
			const what = typeof msg === 'string' ? msg : JSON.stringify(msg)
			const got = input === undefined ? undefined : JSON.stringify(input)
			return [where, what, got === undefined ? undefined : `got ${got}`]
				.filter((p) => p !== undefined && p !== '')
				.join(': ')
		})
		return parts.length ? parts.join('; ') : undefined
	}
	if (raw && typeof raw === 'object') {
		const rec = raw as Record<string, unknown>
		for (const key of ['error', 'message', 'msg']) {
			if (typeof rec[key] === 'string' && (rec[key] as string).trim() !== '') {
				return rec[key] as string
			}
		}
		try {
			return JSON.stringify(raw)
		} catch {
			return undefined
		}
	}
	return undefined
}

export class AlfredClient {
	private baseUrl: string
	private readonly fetchFn: FetchFn
	private readonly defaultTimeoutMs: number
	private webhookSecret: string | undefined
	private streamToken: string | undefined

	constructor(opts: AlfredClientOptions = {}) {
		this.baseUrl = (opts.baseUrl ?? ALFRED_DEFAULT_BASE_URL).replace(/\/+$/, '')
		this.fetchFn = opts.fetchFn ?? fetch
		this.defaultTimeoutMs = opts.defaultTimeoutMs ?? ALFRED_DEFAULT_TIMEOUT_MS
		this.webhookSecret = opts.webhookSecret || undefined
		this.streamToken = opts.streamToken || undefined
	}

	/**
	 * Replace the webhook secret sent as `X-Alfred-Secret` on every BE call.
	 * Empty/`undefined` clears it (local dev).
	 */
	setWebhookSecret(secret: string | undefined): void {
		this.webhookSecret = secret || undefined
	}

	/**
	 * Replace the stream capability used for stream calls.
	 * `undefined` clears it.
	 */
	setStreamToken(token: string | undefined): void {
		this.streamToken = token || undefined
	}

	/**
	 * Install a stream credential as served by the BE's prompt/play response
	 * (`{ generation_id, stream_token, stream_url }`): swaps the stream token
	 * AND the base URL in one step, so the browser never hardcodes a host.
	 * An empty or missing `stream_url` keeps the current URL.
	 */
	setStreamCredential(credential: StreamCredential): void {
		if (!credential?.stream_token) invalid('credential.stream_token is required')
		if (!credential?.generation_id) invalid('credential.generation_id is required')
		this.streamToken = credential.stream_token
		const baseUrl = credential.stream_url?.trim()
		if (baseUrl) {
			// stream_url is `{PUBLIC}/streams/{gid}` — strip the suffix for the base.
			const base = baseUrl.replace(/\/streams\/[^/]*\/?$/, '')
			if (base) this.baseUrl = base.replace(/\/+$/, '')
		}
	}

	/**
	 * Install a run-stream credential as served by the host's start/play
	 * response (`{ run_id, stream_token, stream_url }`, §6 S4): swaps the
	 * stream token AND the base URL in one step. `stream_url` is
	 * `{PUBLIC}/wfstreams/{rid}` — strip that suffix for the base.
	 */
	setRunStreamCredential(credential: WorkflowRunStreamCredential): void {
		if (!credential?.stream_token) invalid('credential.stream_token is required')
		if (!credential?.run_id) invalid('credential.run_id is required')
		this.streamToken = credential.stream_token
		const baseUrl = credential.stream_url?.trim()
		if (baseUrl) {
			const base = baseUrl.replace(/\/wfstreams\/[^/]*\/?$/, '')
			if (base) this.baseUrl = base.replace(/\/+$/, '')
		}
	}

	// -- sessions (BE) ------------------------------------------------------

	/** `POST /sessions` → `{ session_id }`. Creates the container, no start. BE-only. */
	async createSession(
		input: CreateSessionInput,
		signal?: AbortSignal
	): Promise<{ session_id: string }> {
		if (!input?.agent?.model) invalid('agent.model is required')
		const body = compact({
			agent: input.agent,
			toolset: input.toolset,
			metadata: input.metadata,
			credentials: input.credentials,
		})
		return this.beJson('POST', '/sessions', body, signal)
	}

	/** `GET /sessions` → `{ sessions }`. BE-only. */
	async listSessions(signal?: AbortSignal): Promise<{ sessions: SessionSummary[] }> {
		return this.beJson('GET', '/sessions', undefined, signal)
	}

	/** `GET /sessions/{sid}` → `{ id, agent, toolset, status, active_generation_id?, created_at }`. BE-only. */
	async getSession(sid: string, signal?: AbortSignal): Promise<SessionInfo> {
		assertSid(sid)
		return this.beJson('GET', `/sessions/${encodeURIComponent(sid)}`, undefined, signal)
	}

	/** `DELETE /sessions/{sid}` → `{ ok: true }` (stop + archive). BE-only. */
	async deleteSession(sid: string, signal?: AbortSignal): Promise<{ ok: true }> {
		assertSid(sid)
		return this.beJson('DELETE', `/sessions/${encodeURIComponent(sid)}`, undefined, signal)
	}

	// -- generations (BE) -----------------------------------------------------

	/**
	 * `POST /sessions/{sid}/prompt` → `{ generation_id, stream_token, expires_at, stream_url }`.
	 * Creates a generation, appends the user message, starts the loop. BE-only.
	 * `409` when a `running` generation is live (attach via `play`).
	 */
	async prompt(sid: string, input: PromptInput, signal?: AbortSignal): Promise<PromptResult> {
		assertSid(sid)
		assertPrompt(input.prompt)
		return this.beJson(
			'POST',
			`/sessions/${encodeURIComponent(sid)}/prompt`,
			compact({
				prompt: input.prompt,
				webhook_url: input.webhook_url,
				policy_override: input.policy_override,
			}),
			signal,
			201
		)
	}

	/**
	 * `POST /sessions/{sid}/generations/{gid}/play` → `{ stream_token, expires_at, stream_url }`.
	 * Re-mints a stream capability for a LIVE generation. BE-only. `410` on terminal.
	 */
	async play(sid: string, gid: string, signal?: AbortSignal): Promise<PlayResult> {
		assertSid(sid)
		assertGid(gid)
		return this.beJson(
			'POST',
			`/sessions/${encodeURIComponent(sid)}/generations/${encodeURIComponent(gid)}/play`,
			undefined,
			signal
		)
	}

	// -- history (BE) -----------------------------------------------------------

	/** `GET /sessions/{sid}/history` → durable messages + events (never deltas). BE-only. */
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
		return this.beJson(
			'GET',
			`/sessions/${encodeURIComponent(sid)}/history?${params}`,
			undefined,
			signal
		)
	}

	// -- control (BE) -------------------------------------------------------------

	/** `POST /sessions/{sid}/stop` → pause the live generation (no-op when idle). BE-only. */
	async stop(sid: string, signal?: AbortSignal): Promise<{ ok: true; status: string }> {
		assertSid(sid)
		return this.beJson('POST', `/sessions/${encodeURIComponent(sid)}/stop`, undefined, signal)
	}

	/** `POST /sessions/{sid}/resume` → resume the paused generation. BE-only. `409` when nothing paused. */
	async resume(sid: string, signal?: AbortSignal): Promise<{ ok: true; status: string }> {
		assertSid(sid)
		return this.beJson('POST', `/sessions/${encodeURIComponent(sid)}/resume`, undefined, signal)
	}

	/**
	 * `POST /sessions/{sid}/queue` → live: `{ ok, generation_id }` (steer-inject);
	 * idle: full `PromptResult` (creates, URL required in prod). BE-only.
	 */
	async queue(
		sid: string,
		prompt: string,
		webhookUrl?: string,
		signal?: AbortSignal
	): Promise<{ ok: true; generation_id: string } | PromptResult> {
		assertSid(sid)
		assertPrompt(prompt)
		return this.beJson(
			'POST',
			`/sessions/${encodeURIComponent(sid)}/queue`,
			compact({ prompt, webhook_url: webhookUrl }),
			signal
		)
	}

	/** `POST /sessions/{sid}/steer` → inject at next iteration boundary. BE-only. `409` when idle. */
	async steer(sid: string, prompt: string, signal?: AbortSignal): Promise<{ ok: true }> {
		assertSid(sid)
		assertPrompt(prompt)
		return this.beJson('POST', `/sessions/${encodeURIComponent(sid)}/steer`, { prompt }, signal)
	}

	/** `POST /sessions/{sid}/interrupt` → abort in-flight + inject now. BE-only. `409` when idle. */
	async interrupt(sid: string, prompt: string, signal?: AbortSignal): Promise<{ ok: true }> {
		assertSid(sid)
		assertPrompt(prompt)
		return this.beJson('POST', `/sessions/${encodeURIComponent(sid)}/interrupt`, { prompt }, signal)
	}

	/** `POST /sessions/{sid}/backup` → `{ ok: true, path }`. BE-only. */
	async backup(sid: string, signal?: AbortSignal): Promise<{ ok: true; path: string }> {
		assertSid(sid)
		return this.beJson('POST', `/sessions/${encodeURIComponent(sid)}/backup`, undefined, signal)
	}

	/** `GET /health` → `{ ok: true }`. Open. */
	async health(signal?: AbortSignal): Promise<{ ok: true }> {
		return this.json('GET', '/health', undefined, signal)
	}

	// -- tools (BE) ---------------------------------------------------------------

	/**
	 * `GET /tools` → `{ tools: ToolDef[] }` — the live builtin catalogue
	 * (butler `docs/tools.md` §§3–4, `execution.type: 'builtin'`). BE-only.
	 *
	 * This is the live source of truth for tool selection: fetch it to list
	 * the hard-coded tools (description + JSON Schema arguments) alongside
	 * the webhook-defined (`callback`) tools the host app owns. The static
	 * mirror (`BUILTIN_GENERIC`/`BUILTIN_SPECIALISED` in `builtins.ts`) is
	 * for offline selection — prefer this endpoint when Alfred is reachable.
	 */
	async listTools(signal?: AbortSignal): Promise<{ tools: ToolDef[] }> {
		return this.beJson('GET', '/tools', undefined, signal)
	}

	/**
	 * `POST /tools/call` → `{result} | {error}` — invoke one hard-coded
	 * tool directly, outside the agent loop (butler `POST /tools/call`).
	 * BE-only. Stateless: writes no messages/events rows.
	 *
	 * `execution` omitted means builtin; an explicit descriptor selects the
	 * passthrough path (`http` needs `execution.url`, `callback` needs
	 * `webhook_url`, `prompt` needs `alias` + templates inline). `session_id`
	 * is envelope context for store-backed builtins (`artifact`, `recall`,
	 * `document` over stored artifacts) — NOT a tool argument.
	 *
	 * Tool-level failures arrive as `{error}` (returned, not thrown);
	 * only transport/envelope problems (401/404/422/…) throw `AlfredError`.
	 */
	async callTool(input: ToolCallInput, signal?: AbortSignal): Promise<ToolCallResult> {
		if (!input?.name || typeof input.name !== 'string' || input.name.trim() === '')
			invalid('name must be a non-empty string')
		return this.beJson(
			'POST',
			'/tools/call',
			compact({
				name: input.name,
				arguments: input.arguments ?? {},
				session_id: input.session_id,
				execution: input.execution,
				webhook_url: input.webhook_url,
				credentials: input.credentials,
			}),
			signal
		)
	}

	// -- streams (FE, token) ----------------------------------------------------------

	/**
	 * `GET /streams/{gid}` (SSE). Replays durable events since `after_seq`,
	 * then yields live durable events and ephemeral deltas until `signal`
	 * aborts or the generation ends. Uses `fetchFn` + a stream reader (not
	 * `EventSource`) so headers and a mock fetch work in tests.
	 *
	 * Auth: `streamToken` as `Authorization: Bearer` (fetch-reader primary).
	 */
	async *streamEvents(
		gid: string,
		afterSeq = 0,
		signal?: AbortSignal
	): AsyncGenerator<LiveEvent, void, void> {
		assertGid(gid)
		assertAfterSeq(afterSeq)
		const params = new URLSearchParams({ after_seq: String(afterSeq) })
		const url = `${this.baseUrl}/streams/${encodeURIComponent(gid)}?${params}`
		// SSE is a long-lived stream: never apply the implicit per-request
		// timeout. Without a caller `signal` the loop runs until `dispose()`;
		// with one, the caller's abort is the only deadline.
		const headers: Record<string, string> = { accept: 'text/event-stream' }
		if (this.streamToken) headers['authorization'] = `Bearer ${this.streamToken}`
		const res = await this.send(url, { method: 'GET', headers }, signal, null)
		if (!res.ok) throw await this.httpError(res)
		if (!res.body) throw new AlfredError('SSE response has no body', { code: 'parse' })
		for await (const frame of parseSse(res.body)) yield frame as LiveEvent
	}

	/**
	 * `GET /streams/{gid}/poll` → durable replay + live deltas, or `{ timeout: true }`.
	 * Same credential rule as SSE. Fallback ALTERNATIVE to SSE, not a second step.
	 */
	async streamPoll(
		gid: string,
		afterSeq = 0,
		timeoutS?: number,
		signal?: AbortSignal
	): Promise<PollResponse> {
		assertGid(gid)
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
		const headers: Record<string, string> = {}
		if (this.streamToken) headers['authorization'] = `Bearer ${this.streamToken}`
		const res = await this.send(
			`${this.baseUrl}/streams/${encodeURIComponent(gid)}/poll?${params}`,
			{ method: 'GET', headers },
			signal,
			timeoutMs
		)
		if (!res.ok) throw await this.httpError(res)
		try {
			return (await res.json()) as PollResponse
		} catch (err) {
			throw new AlfredError(`invalid JSON response: ${(err as Error).message}`, { code: 'parse' })
		}
	}

	/**
	 * Poll-loop fallback for clients that cannot hold SSE. Yields events and
	 * advances the durable cursor; returns (does not throw) on `{ timeout: true }`.
	 */
	async *pollLoop(
		gid: string,
		opts: { after_seq?: number; timeout_s?: number; signal?: AbortSignal } = {}
	): AsyncGenerator<LiveEvent, void, void> {
		assertGid(gid)
		let cursor = opts.after_seq ?? 0
		assertAfterSeq(cursor)
		while (!opts.signal?.aborted) {
			const res = await this.streamPoll(gid, cursor, opts.timeout_s, opts.signal)
			for (const evt of res.events) yield evt
			const max = maxDurableSeq(res.events)
			if (max !== null) cursor = max + 1
			if (res.timeout) return
		}
	}

	// -- human answers (FE, token) ----------------------------------------------------

	/**
	 * `POST /streams/{gid}/answer/{toolCallId}` — answer a pending human
	 * tool call (butler §9). FE → Alfred direct, no BE hop: the stream token
	 * is the credential (same rule as SSE/poll).
	 *
	 * `value` is the raw answer for generic human tools; `ask_human` accepts
	 * `{ answers: [...] }` (or the bare answers array). Idempotent: answering
	 * an already-resolved wait replays the stored value (`duplicate: True`).
	 * Only transport/envelope problems (401/404/422/…) throw `AlfredError`.
	 */
	async answerHuman(
		gid: string,
		toolCallId: string,
		input: HumanAnswerInput,
		signal?: AbortSignal
	): Promise<{ ok: true; duplicate: boolean; status: string; value: unknown }> {
		assertGid(gid)
		if (!toolCallId || typeof toolCallId !== 'string' || toolCallId.trim() === '')
			invalid('toolCallId must be a non-empty string')
		const body: Record<string, unknown> = Array.isArray(input)
			? { answers: input }
			: input !== null && typeof input === 'object' && !('value' in input) && !('answers' in input)
				? { value: input }
				: (input as Record<string, unknown>)
		const headers: Record<string, string> = { 'content-type': 'application/json' }
		if (this.streamToken) headers['authorization'] = `Bearer ${this.streamToken}`
		const res = await this.send(
			`${this.baseUrl}/streams/${encodeURIComponent(gid)}/answer/${encodeURIComponent(toolCallId)}`,
			{ method: 'POST', headers, body: JSON.stringify(body) },
			signal
		)
		if (!res.ok) throw await this.httpError(res)
		try {
			return (await res.json()) as {
				ok: true
				duplicate: boolean
				status: string
				value: unknown
			}
		} catch (err) {
			throw new AlfredError(`invalid JSON response: ${(err as Error).message}`, { code: 'parse' })
		}
	}

	/**
	 * `GET /streams/{gid}/human` → `{ waiting: HumanPending[] }` — the
	 * still-`waiting` human asks for a generation (butler §9). Same stream
	 * credential as SSE/poll. Lets a freshly-attached UI render pending
	 * question cards without replaying the whole stream.
	 */
	async humanPending(gid: string, signal?: AbortSignal): Promise<{ waiting: HumanPending[] }> {
		assertGid(gid)
		const headers: Record<string, string> = {}
		if (this.streamToken) headers['authorization'] = `Bearer ${this.streamToken}`
		const res = await this.send(
			`${this.baseUrl}/streams/${encodeURIComponent(gid)}/human`,
			{ method: 'GET', headers },
			signal
		)
		if (!res.ok) throw await this.httpError(res)
		try {
			return (await res.json()) as { waiting: HumanPending[] }
		} catch (err) {
			throw new AlfredError(`invalid JSON response: ${(err as Error).message}`, { code: 'parse' })
		}
	}

	/**
	 * Answer an `ask_human` call with per-question answers (typed alias of
	 * {@link answerHuman} for the multiple-choice convention).
	 */
	async answerAskHuman(
		gid: string,
		toolCallId: string,
		answers: AskHumanResult['answers'],
		signal?: AbortSignal
	): Promise<{ ok: true; duplicate: boolean; status: string; value: unknown }> {
		return this.answerHuman(gid, toolCallId, { answers }, signal)
	}

	// -- workflow runs (BE, secret) ----------------------------------------------

	/**
	 * `POST /wfruns {run_id}` → `{ run_id, stream_token, expires_at, stream_url }`.
	 * Register a workflow run stream (idempotent upsert). BE-only.
	 */
	async registerWorkflowRun(
		runId: string,
		signal?: AbortSignal
	): Promise<RegisterWorkflowRunResult> {
		assertRid(runId)
		return this.beJson('POST', '/wfruns', { run_id: runId }, signal, 201)
	}

	/**
	 * `POST /wfruns/{rid}/play` → `{ stream_token, expires_at, stream_url }`.
	 * Re-mint a run-stream capability (reload path). BE-only. 404 on unknown run.
	 */
	async playWorkflowRun(rid: string, signal?: AbortSignal): Promise<PlayWorkflowRunResult> {
		assertRid(rid)
		return this.beJson('POST', `/wfruns/${encodeURIComponent(rid)}/play`, undefined, signal)
	}

	/**
	 * `POST /wfruns/{rid}/events {events: [{type, payload}]}` → `{ run_id, events }`.
	 * Publish a batch of run-local events (best-effort from the host — a
	 * publish failure never fails the tick). BE-only. 404 on unknown run,
	 * 422 on empty batch / unknown type / non-object payload.
	 */
	async publishWorkflowEvents(
		rid: string,
		events: WorkflowRunEventInput[],
		signal?: AbortSignal
	): Promise<{ run_id: string; events: WorkflowRunEvent[] }> {
		assertRid(rid)
		if (!Array.isArray(events) || events.length === 0) invalid('events must be a non-empty array')
		return this.beJson('POST', `/wfruns/${encodeURIComponent(rid)}/events`, { events }, signal, 201)
	}

	// -- workflow run streams (FE, token) ------------------------------------------

	/**
	 * `GET /wfstreams/{rid}` (SSE). Replays run-local durable events since
	 * `after_seq`, then yields live events until `signal` aborts or a
	 * terminal `run_status` closes the stream. Same fetch-reader shape as
	 * {@link streamEvents}; auth is the run-scoped stream token.
	 */
	async *streamWorkflowEvents(
		rid: string,
		afterSeq = 0,
		signal?: AbortSignal
	): AsyncGenerator<WorkflowRunEvent, void, void> {
		assertRid(rid)
		assertAfterSeq(afterSeq)
		const params = new URLSearchParams({ after_seq: String(afterSeq) })
		const url = `${this.baseUrl}/wfstreams/${encodeURIComponent(rid)}?${params}`
		const headers: Record<string, string> = { accept: 'text/event-stream' }
		if (this.streamToken) headers['authorization'] = `Bearer ${this.streamToken}`
		const res = await this.send(url, { method: 'GET', headers }, signal, null)
		if (!res.ok) throw await this.httpError(res)
		if (!res.body) throw new AlfredError('SSE response has no body', { code: 'parse' })
		for await (const frame of parseSse(res.body)) yield frame as WorkflowRunEvent
	}

	/**
	 * `GET /wfstreams/{rid}/poll` → run-local replay + live event, or
	 * `{ timeout: true }`. Same credential rule as the run SSE. Fallback
	 * ALTERNATIVE to SSE, not a second step.
	 */
	async pollWorkflowEvents(
		rid: string,
		afterSeq = 0,
		timeoutS?: number,
		signal?: AbortSignal
	): Promise<WorkflowRunPollResponse> {
		assertRid(rid)
		assertAfterSeq(afterSeq)
		const clamped = clampTimeout(timeoutS)
		const params = new URLSearchParams({
			after_seq: String(afterSeq),
			timeout_s: String(clamped),
		})
		const timeoutMs =
			signal === undefined ? Math.max(this.defaultTimeoutMs, (clamped + 5) * 1000) : undefined
		const headers: Record<string, string> = {}
		if (this.streamToken) headers['authorization'] = `Bearer ${this.streamToken}`
		const res = await this.send(
			`${this.baseUrl}/wfstreams/${encodeURIComponent(rid)}/poll?${params}`,
			{ method: 'GET', headers },
			signal,
			timeoutMs
		)
		if (!res.ok) throw await this.httpError(res)
		try {
			return (await res.json()) as WorkflowRunPollResponse
		} catch (err) {
			throw new AlfredError(`invalid JSON response: ${(err as Error).message}`, { code: 'parse' })
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
		const message = formatDetail(detail) ?? `HTTP ${res.status} ${res.statusText}`
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

	/**
	 * JSON helper for every BE call: same as {@link json} but carries
	 * `X-Alfred-Secret` when a webhook secret is configured. Empty secret =
	 * no header (local dev, mirroring Butler's skipped check).
	 */
	private async beJson<T>(
		method: string,
		path: string,
		body: Record<string, unknown> | undefined,
		signal?: AbortSignal,
		expectStatus?: number,
		timeoutMs?: number | null
	): Promise<T> {
		const init: RequestInit = { method }
		const headers: Record<string, string> = {}
		if (body !== undefined) {
			headers['content-type'] = 'application/json'
			init.body = JSON.stringify(body)
		}
		if (this.webhookSecret) headers['x-alfred-secret'] = this.webhookSecret
		init.headers = headers
		console.log(`Alfred's whatsapp: ${this.baseUrl}${path}`)
		const res = await this.send(`${this.baseUrl}${path}`, init, signal, timeoutMs)
		if (!res.ok) throw await this.httpError(res)
		if (expectStatus !== undefined && res.status !== expectStatus) {
			// Status documented but not enforced — the body is the contract.
		}
		if (res.status === 204) return undefined as T
		try {
			return (await res.json()) as T
		} catch (err) {
			throw new AlfredError(`invalid JSON response: ${(err as Error).message}`, { code: 'parse' })
		}
	}
}
