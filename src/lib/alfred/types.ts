/**
 * Alfred client types — the wire contract with the Butler (`butler/docs/alfred.md`).
 *
 * Streaming is FE-only (a generation stream capability on `/streams/*`),
 * generation stream capability on `/streams/*`), everything else is BE-only
 * (`X-Alfred-Secret`). The wire is the contract: keys stay snake_case exactly
 * as the server emits them. TS interfaces are camelCase only where the value
 * is purely client-side.
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
export type ExecutionType = 'http' | 'callback' | 'inline_deny' | 'builtin' | 'prompt'

export interface ExecutionConfig {
	type: ExecutionType
	/**
	 * Target URL for `http` tools only. `callback` tools carry NO url —
	 * the per-generation `webhook_url` on `prompt` is the only destination
		 * (see `butler/docs/alfred.md` §2.1). A `url` sent for `callback` is ignored.
	 */
	url?: string
	timeout_ms?: number
	/**
	 * `prompt` execution only (butler `docs/tools.md` §7): alias allowlist
	 * `text | extract | vision | jev`, session-fixed templates rendered
	 * server-side from the model's arguments, optional JSON schema +
	 * sampling params.
	 */
	alias?: string
	system_template?: string
	user_template?: string
	response_format?: Record<string, unknown>
	max_tokens?: number
	temperature?: number
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

/** Body of `POST /sessions` — creates the container, does NOT start the loop. */
export interface CreateSessionInput {
	agent: AgentConfig
	toolset?: ToolsetConfig
	metadata?: Record<string, unknown>
}

/** Body of `POST /sessions/{id}/prompt` — creates a generation + starts it. */
export interface PromptInput {
	prompt: string
	/** Per-generation callback destination (§8). Required in prod, optional in dev. */
	webhook_url?: string
	policy_override?: Record<string, unknown>
}

/** `prompt` / idle-`queue` response: the generation + its first stream capability. */
export interface PromptResult {
	generation_id: string
	stream_token: string
	expires_at: number
	stream_url: string
}

/** `play` response: a fresh stream capability for a live generation. */
export interface PlayResult {
	stream_token: string
	expires_at: number
	stream_url: string
}

/** What the FE needs to open a stream (from the BE's prompt/play response). */
export interface StreamCredential {
	generation_id: string
	stream_token: string
	stream_url: string
}

/** `GET /sessions/{id}` — full detail (agent + toolset + status). */
export interface SessionInfo {
	id: string
	status: string
	active_generation_id?: string
	agent: AgentConfig
	toolset: ToolsetConfig
	created_at: string
}

/**
 * `GET /sessions` row — a summary, NOT the full detail:
 * `{id, status, model, created_at, message_count, event_count}`. The server
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

/** Durable event types — persisted in SQLite with a generation-local `seq`. */
export type DurableType = 'thought' | 'tool_use' | 'tool_result' | 'answer' | 'done' | 'error'

/** Ephemeral event types — live only, never stored. */
export type DeltaType = 'thought_delta' | 'answer_delta' | 'tool_use_delta'

export type AlfredEventType = DurableType | DeltaType

/** A persisted event (stream replay, `poll`, history). `seq` is generation-local. */
export interface DurableEvent {
	seq: number
	type: DurableType
	payload: Record<string, unknown>
	ts: string
}

/** A live-only streaming delta. `stream_id` IS the generation_id (§3). */
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

/** `GET /streams/{gid}/poll` response. */
export interface PollResponse {
	events: LiveEvent[]
	next_seq: number
	timeout: boolean
}

export type EventPayload = Record<string, unknown>
