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
export type ExecutionType = 'http' | 'callback' | 'inline_deny' | 'builtin' | 'prompt' | 'human'

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
	/**
	 * `human` execution only (butler §9): wait deadline in seconds (`0` =
	 * wait indefinitely), expiry policy (`autopick` resolves with
	 * `default_value`, `error` resolves as a tool error), and the autopick
	 * value. The `ask_human` multiple-choice convention needs no
	 * `default_value`: it autopicks each question's first option.
	 */
	timeout_s?: number
	on_timeout?: 'autopick' | 'error'
	default_value?: unknown
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
	/**
	 * Per-app LLM credentials (BE-owned). Alfred stores the key on the
	 * session so background continuations work with no BE in the loop.
	 */
	credentials?: { openrouter_api_key?: string }
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
export type DurableType =
	| 'thought'
	| 'tool_use'
	| 'tool_result'
	| 'answer'
	| 'done'
	| 'error'
	| 'human_question'
	| 'human_answer'

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

/**
 * Body of `POST /tools/call` — invoke one hard-coded tool directly, outside
 * the agent loop (see `butler/src/alfred/app.py::call_tool`). BE-only.
 *
 * `name` + `arguments` are the invocation; `session_id` is envelope context
 * (NOT a tool argument) used only to scope store-backed builtins
 * (`artifact`, `recall`, `document` over stored artifacts). `execution`
 * omitted means builtin; an explicit descriptor selects the passthrough
 * path (`http` needs `execution.url`, `callback` needs `webhook_url`,
 * `prompt` needs `alias` + templates inline — no session lookup).
 */
export interface ToolCallInput {
	name: string
	arguments?: Record<string, unknown>
	session_id?: string
	execution?: ExecutionConfig
	webhook_url?: string
	/** Stateless direct-call key (no session lookup): `{ openrouter_api_key }`. */
	credentials?: { openrouter_api_key?: string }
}

/**
 * `POST /tools/call` response — `{result} | {error}`, never both.
 * Tool-level failures (bad args, sidecar errors, downstream non-2xx) arrive
 * as `{error}` with HTTP 200, matching loop semantics; envelope problems
 * (unknown name, malformed body) are HTTP 4xx surfaced as `AlfredError`.
 */
export type ToolCallResult = { result: unknown } | { error: unknown }

export type EventPayload = Record<string, unknown>

/**
 * Human-in-the-loop (§9). Any tool with `execution.type: 'human'` suspends
 * the loop until the FE answers. The tool's `parameters` (JSON Schema) is
 * the contract between the app BE (declares it), the model (fills the
 * arguments) and the FE (registers a `{tool: ToolComponent}` renderer keyed
 * by tool name, which uses the parameters to render and produces the value).
 * Butler stores the raw arguments as the question and feeds the raw posted
 * value back as the tool result — it validates deeply only the `ask_human`
 * convention below.
 */

/** One multiple-choice question of the `ask_human` convention. */
export interface HumanQuestion {
	id: string
	text: string
	/** Options; the FIRST is the preferred default (timeout autopick). */
	options: string[]
	allow_free_text?: boolean
}

/** Arguments the model passes to `ask_human`. */
export interface AskHumanInput {
	questions: HumanQuestion[]
	/** Per-call overrides of the descriptor `timeout_s` / `on_timeout`. */
	timeout_s?: number
	on_timeout?: 'autopick' | 'error'
}

/** One answered question of the `ask_human` convention. */
export interface HumanAnswer {
	id: string
	choice?: string
	text?: string
	autopicked: boolean
	timed_out: boolean
}

/** `ask_human` tool result (fed back as the tool message content). */
export interface AskHumanResult {
	answers: HumanAnswer[]
}

/** Durable `human_question` payload (generic: `arguments` + `parameters`). */
export interface HumanQuestionPayload {
	tool_call_id: string
	/** Tool name — selects the FE-registered renderer. */
	name: string
	/** `ask_human` only: the validated questions. */
	questions?: HumanQuestion[]
	/** Generic tools: the raw model arguments. */
	arguments?: Record<string, unknown>
	/** Generic tools: the descriptor `parameters` for the renderer. */
	parameters?: Record<string, unknown>
	timeout_s: number
	on_timeout: 'autopick' | 'error'
}

/** Durable `human_answer` payload. */
export interface HumanAnswerPayload {
	tool_call_id: string
	tool_name: string
	timed_out: boolean
	autopicked: boolean
	/** `ask_human` only. */
	answers?: HumanAnswer[]
	/** Generic tools: the raw posted value. */
	value?: unknown
}

/** One still-`waiting` row of `GET /streams/{gid}/human`. */
export interface HumanPending {
	generation_id: string
	tool_call_id: string
	session_id: string
	tool_name: string
	/** Raw model arguments (the question). */
	payload: Record<string, unknown>
	/** `ask_human` only. */
	questions?: HumanQuestion[]
	deadline: number
	on_timeout: 'autopick' | 'error'
	status: string
	created_at: string
}

/** Body of `POST /streams/{gid}/answer/{tool_call_id}`. */
export type HumanAnswerInput =
	| { value: unknown }
	| { answers: HumanAnswer[] }
	| HumanAnswer[]
	| Record<string, unknown>

/** A human tool descriptor (app-BE-declared, FE-rendered). */
export interface HumanToolDef {
	name: string
	description: string
	parameters: { type: 'object'; properties: Record<string, unknown>; required?: string[] }
	timeout_s?: number
	on_timeout?: 'autopick' | 'error'
	default_value?: unknown
}
