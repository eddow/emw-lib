/**
 * Alfred client types — the wire contract with the Butler (`butler/alfred.md`,
 * FastAPI on `:8192`).
 *
 * These mirror `butler/src/alfred/models.py` + `app.py` envelopes. The wire is
 * the contract: keys stay snake_case exactly as the server emits them. TS
 * interfaces are camelCase only where the value is purely client-side.
 *
 * No imports here — this module is types only, usable from browser + node.
 */

/** Injectable fetch, same convention as `serps/types.ts` and `scrappers/bodacc`. */
export type FetchFn = typeof fetch

/** `agent` block of `POST /sessions` (OpenRouter passthrough). */
export interface AgentConfig {
	/** OpenRouter model id, e.g. `anthropic/claude-sonnet-4`. Required. */
	model: string
	system_prompt?: string
	temperature?: number
	max_tokens?: number
}

/** How Alfred runs a tool. `inline_deny` is the safe default for unknown tools. */
export type ExecutionType = 'http' | 'callback' | 'inline_deny'

export interface ExecutionConfig {
	type: ExecutionType
	/**
	 * Target URL for `http` / `callback` executions. Optional for
	 * `callback`: an empty/missing url falls back to Alfred's env-owned
	 * `ALFRED_TOOL_WEBHOOK_URL` (`butler/alfred.md` §2.1), so clients
	 * normally omit it and dispatch is by tool `name` only.
	 */
	url?: string
	timeout_ms?: number
}

/** OpenAI-compatible tool definition plus Alfred's `execution` descriptor. */
export interface ToolDef {
	name: string
	description?: string
	/** JSON Schema for the tool arguments. */
	parameters?: Record<string, unknown>
	execution?: ExecutionConfig
}

export interface ToolsetPolicy {
	max_iterations?: number
	tool_choice?: 'auto' | 'none' | 'required'
}

export interface ToolsetConfig {
	tools?: ToolDef[]
	policy?: ToolsetPolicy
}

/** Body of `POST /sessions`. */
export interface CreateSessionInput {
	agent: AgentConfig
	toolset?: ToolsetConfig
	initial_prompt?: string
	metadata?: Record<string, unknown>
}

/** Durable event types — persisted in SQLite with a monotonic `seq`. */
export type DurableType = 'thought' | 'tool_use' | 'tool_result' | 'answer' | 'done' | 'error'

/** Ephemeral event types — live only, never stored. */
export type DeltaType = 'thought_delta' | 'answer_delta' | 'tool_use_delta'

export type AlfredEventType = DurableType | DeltaType

/** A persisted event (`GET /history`, SSE replay, `poll`). */
export interface DurableEvent {
	seq: number
	type: DurableType
	payload: Record<string, unknown>
	ts: string
}

/** A live-only streaming delta. */
export interface DeltaEvent {
	type: DeltaType
	stream_id: string
	stream_seq: number
	text: string
}

/**
 * Anything the SSE / poll stream can yield. Deltas carry no `seq`; durable
 * events always do. `seq` is optional here because the union must accept both.
 */
export type LiveEvent = (DurableEvent | DeltaEvent) & { seq?: number }

/** `GET /sessions/{id}/history` item — a message or a durable event. */
export interface HistoryItemMessage {
	kind: 'message'
	seq: number
	role: string
	content: unknown
}

export interface HistoryItemEvent {
	kind: 'event'
	seq: number
	type: string
	payload: unknown
	ts: string
}

export type HistoryItem = HistoryItemMessage | HistoryItemEvent

/** `GET /sessions/{id}/poll` response. */
export interface PollResponse {
	events: LiveEvent[]
	next_seq: number
	timeout: boolean
}

/** `GET /sessions/{id}` — full detail (agent + toolset + runtime status). */
export interface SessionInfo {
	id: string
	status: string
	runtime_status?: string
	agent: AgentConfig
	toolset: ToolsetConfig
	created_at: string
}

/**
 * `GET /sessions` row — a summary, NOT the full detail (`butler/alfred.md` §5:
 * `{id, status, model, created_at, message_count, event_count}`). The server
 * never sends `agent`/`toolset` here, so a separate type keeps `listSessions`
 * honest.
 */
export interface SessionSummary {
	id: string
	status: string
	model: string
	created_at: string
	message_count: number
	event_count: number
}

/**
 * Payload shapes (documented, not over-typed — the server may add keys):
 * - `answer` / `thought` → `{ text, stream_id, delta_count, started_ts, ended_ts }`
 * - `tool_use` → `{ tool_call_id, name, arguments }`
 * - `tool_result` → `{ tool_call_id, name?, output }`
 * - `done` → `{ reason }`
 * - `error` → `{ error }`
 */

/**
 * Browser credential for Alfred (`butler/alfred.md` §7.1, as served by
 * `emw`'s `POST /(priv)/agent/token`).
 *
 * The URL travels WITH the token — the browser never hardcodes a host and
 * never reads `env`: `emw` mints `{ token, expires_at }` from Alfred and
 * attaches its own `base_url` (`env.ALFRED_PUBLIC_URL`). An empty `base_url`
 * means "same default as {@link ALFRED_DEFAULT_BASE_URL}".
 */
export interface AlfredCredential {
	token: string
	expires_at?: string
	base_url?: string
}
export type EventPayload = Record<string, unknown>
