# Alfred Client — `emw-lib` (`src/lib/alfred/`)

Alfred's "whatsapp": the TypeScript client through which frontends (`emw`,
demos, scripts) talk to the Butler (`butler/alfred.md`, FastAPI on `:8192`).
Companion to `emw/plans/harness.md` (server loop) and
`emw/plans/agent-chats.md` (stateful widget) — this file owns **only** the
transport + types + streaming reducer + the reactive session wrapper. No LLM
logic, no DB. One generic Svelte chat lives here too (§10) — the minimal
interface any frontend (demo, `emw` widget) mounts; domain styling stays in
`emw`.

## 0. Decisions

- **Location: `emw-lib`, not `emw`.** Any frontend (landing, priv, scripts)
  imports it via `$lib` / package root. Same reason `serps` and
  `scrappers/bodacc` live here: pure TS, injectable `fetch`, unit-tested.
- **Svelte-friendly, layered.** The core (`types.ts`, `client.ts`,
  `stream.ts`, `transcript.ts`) stays framework-free and runs in browser +
  node. On top sit two Svelte-aware modules: `session.svelte.ts` (§5),
  exposing a `$state`-ful `ButlerSession`, and `Chat.svelte` (§10), the
  minimal chat interface mounting it. Runes/components are used only there;
  nothing in the core imports Svelte.
- **SSE primary, `poll` fallback.** Mirrors `butler/alfred.md` §4: deltas are
  ephemeral (live only), finals are durable (SQLite). The lib never persists
  deltas — it reduces them into in-memory text and discards them on `answer` /
  `thought` completion.
- **`jev` and domain tools live in `emw`, not here.** This lib only carries
  the `toolset.tools[].execution` descriptors through on `POST /sessions`;
  it never executes tools.
- **Tools are `callback`-only for `emw`.** `emw` runs on Vercel and cannot
  hold a connection, so it never uses `execution.type: 'http'`. Alfred POSTs
  the `tool_use` to an `emw` webhook (fire-and-forget, `202`), `emw` executes
  under `waitUntil` and PUTs the result back to `/sessions/{id}/tool-callback`.
  Canonical contract: `butler/alfred.md` §2.1. The lib's job is the descriptor
  (`toToolset`) and the webhook adapter (`createToolHandler`) — see §9.
- **Two planes: control via `emw`, stream direct with a token.**
  - **Control** (`createSession`, `steer`, `stop`, `history`, session↔chat
    binding) goes browser → `emw` → Alfred. Short request/response, priv-gated,
    needs DB writes. `emw` reads `env.BUTLER_URL` (`$env/dynamic/private`).
  - **Stream** (`events()`, SSE) goes browser → Alfred **directly**, at
    `ALFRED_PUBLIC_URL`. A Vercel function cannot hold a long-lived connection,
    so proxying the stream through `emw` would reintroduce the very timeout the
    callback tool design exists to avoid.
  - **Auth is a per-session token.** The browser asks `emw` (priv-gated) for a
    token; `emw` calls Alfred's `POST /sessions/{id}/token` with the shared
    secret; Alfred returns an HMAC token scoped to that session. The browser
    then sends `Authorization: Bearer <token>` on every Alfred request. Alfred's
    URL is therefore **visible** to the client — accepted: it is useless without
    a token, and obscurity was never the security.
  - **1h expiry, refreshed invisibly.** `ButlerSession` takes a
    `refreshToken` callback and re-mints on `401`, so the user never sees it.
    It may return `string | AlfredCredential` — the refreshed URL travels
    with the token via `setCredential()`.
  - The lib stays env-free: the browser takes a single `AlfredCredential
    { token, expires_at?, base_url? }` (the token route's response shape).
    `emw` mints `{ token, expires_at }` from Alfred and attaches its own
    `base_url` (`env.ALFRED_PUBLIC_URL`); server-side callers use
    `env.BUTLER_URL` with `X-Alfred-Secret` and no token. Default when unset:
    `http://localhost:8192` ({@link ALFRED_DEFAULT_BASE_URL}).

## 1. Conventions (must follow)

- `FetchFn = typeof fetch` injection, defaulting to global `fetch` — same as
  `src/lib/serps/types.ts` and `scrappers/bodacc/client.ts`. All network I/O
  goes through it (tests pass a mock; no live OpenRouter in tests).
- Client-safe only: no `node:` imports, no SvelteKit `$lib/server`. Works in
  browser + node (vitest `server` project).
- Biome style: tabs, single quotes, `semicolons: asNeeded`, ~100 cols.
- Errors: single `AlfredError extends Error` with `{ status, code, detail }`.
  Transport failures, non-2xx, and timeouts all surface as `AlfredError` —
  never raw `Response`.
- Validate inputs client-side (mirror server `fail(400)` shapes): `sid`
  non-empty, `prompt` 1..4000 chars, `timeout_s` clamped 0..60, `after_seq`
  integer ≥ 0. Throw `AlfredError{ code: 'validation' }` before fetching.

## 2. Types (`src/lib/alfred/types.ts`)

Mirror `butler/src/alfred/models.py` + `app.py` envelopes (TS names camelCase
on the wire stays snake_case — the wire is the contract, do not rename keys):

```ts
export type FetchFn = typeof fetch

export interface AgentConfig {
	model: string // OpenRouter id, required
	system_prompt?: string
	temperature?: number
	max_tokens?: number
}

export type ExecutionType = 'http' | 'callback' | 'inline_deny'
export interface ExecutionConfig {
	type: ExecutionType
	url?: string
	timeout_ms?: number
}
export interface ToolDef {
	name: string
	description?: string
	parameters?: Record<string, unknown> // JSON Schema
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
export interface CreateSessionInput {
	agent: AgentConfig
	toolset?: ToolsetConfig
	initial_prompt?: string
	metadata?: Record<string, unknown>
}

// durable event types (persisted, monotonic `seq`)
export type DurableType = 'thought' | 'tool_use' | 'tool_result' | 'answer' | 'done' | 'error'
// ephemeral (live only, never stored)
export type DeltaType = 'thought_delta' | 'answer_delta' | 'tool_use_delta'
export type AlfredEventType = DurableType | DeltaType

export interface DurableEvent {
	seq: number
	type: DurableType
	payload: Record<string, unknown>
	ts: string
}
export interface DeltaEvent {
	type: DeltaType
	stream_id: string
	stream_seq: number
	text: string
}
export type LiveEvent = (DurableEvent | DeltaEvent) & { seq?: number }

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

export interface PollResponse {
	events: (DurableEvent | DeltaEvent & { seq?: number })[]
	next_seq: number
	timeout: boolean
}
export interface SessionInfo {
	id: string
	status: string
	runtime_status?: string
	agent: AgentConfig
	toolset: ToolsetConfig
	created_at: string
}
// `GET /sessions` row — a summary, NOT the full detail
// (`butler/alfred.md` §5): no `agent`/`toolset` on the wire.
export interface SessionSummary {
	id: string
	status: string
	model: string
	created_at: string
	message_count: number
	event_count: number
}
// Browser credential — the token route's response shape. The URL travels
// WITH the token; the browser never hardcodes a host, never reads env.
export interface AlfredCredential {
	token: string
	expires_at?: string
	base_url?: string
}
```

Payload shapes (document, do not over-type — server may add keys):
`answer`/`thought` → `{ text, stream_id, delta_count, started_ts, ended_ts }`;
`tool_use` → `{ tool_call_id, name, arguments }`;
`tool_result` → `{ tool_call_id, name?, output }`;
`done` → `{ reason }`; `error` → `{ error }`.

## 3. Client (`src/lib/alfred/client.ts`)

```ts
export interface AlfredClientOptions {
	baseUrl?: string // default 'http://localhost:8192', trailing slash trimmed
	authToken?: string // per-session bearer token → `Authorization: Bearer`
	fetchFn?: FetchFn
	defaultTimeoutMs?: number // default 30000; per-call `signal` always wins
}

export class AlfredError extends Error {
	status?: number
	code: string
	detail?: unknown
}

export class AlfredClient {
	constructor(opts?: AlfredClientOptions)
	setAuthToken(token: string | undefined): void
	setCredential(credential: AlfredCredential): void // swaps token + URL atomically
	// sessions
	createSession(input: CreateSessionInput, signal?: AbortSignal): Promise<{ session_id: string }>
	listSessions(signal?: AbortSignal): Promise<{ sessions: SessionSummary[] }>
	getSession(sid: string, signal?: AbortSignal): Promise<SessionInfo>
	deleteSession(sid: string, signal?: AbortSignal): Promise<{ ok: true }>
	// history / poll
	history(sid: string, after_seq?: number, type?: string, signal?: AbortSignal): Promise<{ events: HistoryItem[] }>
	poll(sid: string, after_seq?: number, timeout_s?: number, signal?: AbortSignal): Promise<PollResponse>
	// control
	stop(sid: string, signal?: AbortSignal): Promise<{ ok: true; status: string }>
	resume(sid: string, signal?: AbortSignal): Promise<{ ok: true; status: string }>
	queue(sid: string, prompt: string, signal?: AbortSignal): Promise<{ ok: true }>
	steer(sid: string, prompt: string, signal?: AbortSignal): Promise<{ ok: true }>
	redirect(sid: string, prompt: string, signal?: AbortSignal): Promise<{ ok: true }>
	toolCallback(sid: string, body: { tool_call_id: string; result?: unknown; error?: unknown }, signal?: AbortSignal): Promise<{ ok: true }>
	mintToken(sid: string, signal?: AbortSignal): Promise<{ token: string; expires_at: string }>
	expireCallbacks(sid: string, signal?: AbortSignal): Promise<{ ok: true; expired: number }>
	backup(sid: string, signal?: AbortSignal): Promise<{ ok: true; path: string }>
	health(signal?: AbortSignal): Promise<{ ok: true }>
	// streaming (see §4)
	events(sid: string, after_seq?: number, signal?: AbortSignal): AsyncGenerator<LiveEvent, void, void>
	pollLoop(sid: string, opts?: { after_seq?: number; timeout_s?: number; signal?: AbortSignal }): AsyncGenerator<LiveEvent, void, void>
}
```

Semantics (must match server):

- `queue` — waits for `done` (server restarts a finished/paused loop, else
  steers the running one). `steer` — next iteration boundary only, never
  aborts. `redirect` — aborts in-flight, injects immediately, resumes.
- `events()` parses SSE (`event: <type>\ndata: <json>`) via `fetchFn` +
  `ReadableStream` reader (NOT `EventSource` — needs headers/custom fetch for
  tests, and `Authorization: Bearer`). Replays durable since `after_seq`,
  then yields live durable + deltas until `signal` aborts. Yields parsed
  objects; skips SSE comments/heartbeats; throws `AlfredError` on non-2xx
  before body.
- `pollLoop()` — fallback where SSE cannot be held: `poll`, yield events,
  advance cursor to `next_seq` (durable) or keep cursor on pure-delta batches,
  repeat until `signal` aborts. Returns (not throws) on `{ timeout: true }`.
- URL building: `${baseUrl}/sessions/${encodeURIComponent(sid)}/...`;
  query via `URLSearchParams` (`after_seq`, `type`, `timeout_s`).
- JSON bodies for `queue`/`steer`/`redirect` are `{ prompt }`; never send
  `undefined` keys.

## 4. Streaming reducer (`src/lib/alfred/stream.ts`)

Headless, no DOM — `emw`'s widget feeds it `LiveEvent`s:

```ts
export interface StreamState {
	text: string // current answer draft (deltas applied)
	thought: string // current reasoning draft
	status: 'streaming' | 'done' | 'error'
	lastSeq: number // highest durable seq seen
}
export function createStreamState(): StreamState
export function applyLiveEvent(state: StreamState, evt: LiveEvent): StreamState
```

Rules: `answer_delta` appends `text`; `thought_delta` appends `thought`;
durable `answer`/`thought` **replace** the draft with `payload.text` and clear
pending deltas for that `stream_id`; `done`/`error` flip `status`; durable
events advance `lastSeq`; deltas never touch `lastSeq` (cursor for
reconnect comes from durable `seq` only — deltas are dropped on restart, same
as the server).

## 5. Reactive session (`src/lib/alfred/session.svelte.ts`)

Svelte 5 runes wrapper over `AlfredClient` + the §4 reducer. It owns the
lifecycle a consumer would otherwise wire by hand: create/attach, the SSE
loop, the reconnect cursor, and the reactive state a component renders.

```ts
export type ButlerStatus = 'idle' | 'running' | 'streaming' | 'paused' | 'done' | 'error'
export type SendMode = 'queue' | 'steer' | 'redirect'

export class ButlerSession {
	constructor(opts: { client: AlfredClient; autoStream?: boolean; eventLogLimit?: number; refreshToken?: () => Promise<string | AlfredCredential> })

	id = $state<string | null>(null)
	status = $state<ButlerStatus>('idle')
	stream = $state<StreamState>(createStreamState())
	events = $state<LiveEvent[]>([])      // live log this connection
	history = $state<HistoryItem[]>([])   // durable, via loadHistory()
	error = $state<string | null>(null)
	attached: Promise<void>               // resolves when the SSE loop ends

	readonly text = $derived(this.stream.text)
	readonly thought = $derived(this.stream.thought)
	readonly lastSeq = $derived(this.stream.lastSeq)
	readonly isStreaming = $derived(this.#abort !== null) // connection, not agent status

	get client(): AlfredClient

	create(input: CreateSessionInput): Promise<string>
	attach(sid?: string | null): Promise<void>
	send(prompt: string, mode?: SendMode): Promise<void>
	stop(): Promise<void>
	resume(): Promise<void>
	loadHistory(afterSeq?: number): Promise<void>
	dispose(): void
	reset(): void
}
```

Rules:

- **Reuse `applyLiveEvent`.** `stream` is reassigned from the tested reducer
  (`this.stream = applyLiveEvent(this.stream, evt)`); the class is a lifecycle
  shell, never a second implementation of the delta/final/cursor rules.
- **Explicit `attach()` / `dispose()`, not `$effect`.** `$effect` only runs
  inside a component or an effect root, so a class built in a plain module or
  a test would silently never subscribe. Teardown is the caller's job — one
  `$effect(() => () => session.dispose())` at the call site.
- **Never a module-level singleton.** `$state` at module scope is shared
  across requests during SSR and would leak one session into another's render.
  Instantiate per component (or via `setContext`).
- **`send()` takes a `mode`**, not three methods: `queue` (waits for `done`),
  `steer` (next breath), `redirect` (aborts in-flight) — so the UI can pick
  per button. The SSE loop survives turns; it is only re-attached if it ended.
- **`autoStream`** (default `true`) attaches on `create()` / `resume()`;
  set `false` for headless/scripted use where the caller drives `attach()`.

## 6. File blueprint

```
emw-lib/src/lib/alfred/
	types.ts             # §2 — types only, no imports
	client.ts            # §3 — AlfredClient + AlfredError, imports types only
	stream.ts            # §4 — reducer, imports types only
	transcript.ts        # §10 — history/events → ChatMessage[], imports types + stream only
	session.svelte.ts    # §5 — ButlerSession (runes; Svelte-aware)
	Chat.svelte          # §10 — AlfredChat (minimal chat; Svelte-aware)
	index.ts             # barrel (types re-exported explicitly — see below)
	client.test.ts       # mocked FetchFn: CRUD URLs/bodies, SSE parser, pollLoop cursor, validation
	stream.test.ts       # delta apply → final replace → done; lastSeq ignores deltas
	transcript.test.ts   # history/events → messages; deltas skipped; draft pending
	session.svelte.test.ts  # runes: create/attach/send/stop/resume/dispose/reset
	Chat.svelte.test.ts     # browser: create+stream render, send posts queue, error alert
	ChatTestHost.svelte     # test-only host passing props into Chat.svelte
```

- `src/lib/index.ts` gains `export * from './alfred/index.js'`.
- `index.ts` re-exports `types.ts` **explicitly** (not `export *`) because
  `FetchFn` collides with the identically-named type already exported by
  `serps/types.ts`; the Alfred flavour is `AlfredFetchFn`.
- No `+server.ts`, no env reads in this lib (`baseUrl` is a constructor arg;
  `emw` passes `env.BUTLER_URL` — see §0).
- Tests follow `scrappers/bodacc/client.test.ts` style: faithful fixtures of
  real wire shapes (SSE chunk strings, `poll` JSON, `history` JSON), mocked
  `FetchFn` asserting URL + method + body, `requireAssertions: true`.
- **Test placement matters:** `session.svelte.test.ts` matches the `client`
  vitest project (`src/**/*.svelte.{test,spec}.ts`, browser/playwright) where
  runes work; a plain `session.test.ts` would land in the node `server`
  project instead.

## 7. Test matrix (minimum)

1. `createSession` posts `{ agent, toolset, initial_prompt, metadata }` → `{ session_id }`.
2. `history`/`poll` encode `after_seq`/`type`/`timeout_s`; `timeout: true`
   yields no throw.
3. `events()` parses multi-chunk SSE (`data: [DONE]` ignored, comments
   skipped), aborts cleanly on `AbortSignal`.
4. `queue` vs `steer` vs `redirect` hit distinct paths with `{ prompt }`.
5. Validation: empty `sid`/`prompt`, negative `after_seq` throw before fetch.
6. Reducer: 3 deltas + final replace + `done`; delta after restart (no
   `lastSeq` advance) is discarded on reconnect.
7. `ButlerSession`: `create` posts + attaches; deltas reduce into `text`;
   reconnect resumes from `lastSeq`; `send` routes queue/steer/redirect;
   `stop`/`resume`; `dispose` aborts without flipping to `error`; `reset`
   clears every field.

## 8. Non-goals / future

- **Auth is a bearer token, not a cookie.** `authToken?: string` on
  `AlfredClientOptions` → `Authorization: Bearer` in the single `send()`
  choke point; `setAuthToken()` swaps the token, `setCredential()` swaps
  token + URL atomically. `ButlerSession` takes
  `refreshToken?: () => Promise<string | AlfredCredential>` and re-mints once
  on `401` (§0). Server-side callers leave both unset and use `X-Alfred-Secret`.
- No env reads here: `BUTLER_URL` (server-side) / `ALFRED_PUBLIC_URL` (browser,
  via `AlfredCredential.base_url`) are resolved by `emw` (§0) and passed in.
  A future `fromEnv()` helper would still live in `emw`, not in this lib.
- No tool execution here (`http`/`callback` targets live in `emw`
  `src/lib/server/`); no `inline_deny` logic beyond carrying the descriptor.
- No chat persistence (`agent_chats` tables stay in `emw` per
  `emw/plans/agent-chats.md`); this lib is transport + ephemeral stream state.
- The generic `AlfredChat` (§10) is intentionally unstyled domain-wise:
  layout + classes only, no design system. `emw`'s `AgentChat.svelte` owns the
  drawer, entity badges, context chip and `draftPatch` apply.

## 9. Tool serving (`src/lib/alfred/tools.ts`)

One `AgentTool` produces **both** halves of the callback contract, so the
descriptor Alfred sees and the function `emw` runs cannot drift. (Named
`AgentTool`, not `ToolDef`, to avoid colliding with the wire `ToolDef` in §2.)

```ts
export interface ToolScope {
	sessionId: string
	toolCallId: string
	name: string
	/** Aborts when the session is stopped/redirected. */
	signal: AbortSignal
	/** Resolved by the host app from `sessionId` — NEVER trusted from the wire. */
	scope: Record<string, unknown>
}

export interface AgentTool<I = unknown, O = unknown> {
	name: string
	description: string
	parameters: { type: 'object'; properties: Record<string, unknown>; required?: string[] }
	execute: (input: I, ctx: ToolScope) => Promise<O>
}

/** What `emw` sends to Alfred on `POST /sessions` — every tool is `callback`. */
export function toToolset(
	tools: AgentTool[],
	webhookUrl: string,
	policy?: ToolsetPolicy
): ToolsetConfig

/** The webhook adapter: verify → dedupe → waitUntil(execute) → PUT back. */
export function createToolHandler(opts: {
	tools: AgentTool[]
	/** sessionId → { chatId, entityId, … }. Host app owns the lookup. */
	resolveScope?: (sessionId: string) => Promise<Record<string, unknown>>
	/** Shared-secret check — Alfred has no salt cookie. */
	authorize?: (req: Request) => boolean | Promise<boolean>
	timeoutMs?: number
}): (req: Request) => Promise<Response>
```

Rules:

- **Unknown tool → `200 {error}`**, not 404. Alfred turns it into an
  `is_error` tool result so the model can recover; a transport failure would
  just kill the turn.
- **Throwing tool → `200 {error}`**, same reason. Only a malformed request is
  a `400`.
- **Dedupe on `tool_call_id`** before executing (at-least-once delivery).
- **`202` before work**; execution runs under `waitUntil`.
- **`resolveScope` is the host app's job** — the lib never reads the DB.

Where each piece lives:

| Piece | Home | Why |
|---|---|---|
| `AgentTool`, `ToolScope`, `toToolset`, `createToolHandler` | `emw-lib` | Pure transport plumbing, framework-free, unit-testable |
| The actual tools (DB queries) | `emw/src/lib/server/agent/tools.ts` | Needs `getSql()` |
| `resolveScope(sessionId)` | `emw` | Needs the session↔chat mapping |
| The route mounting the handler | `emw` | Needs auth + env |

### 9.1 jev — case-by-case, never a generic passthrough

`emw/prospect/hunting.md` §3 is explicit: raw company state is passed to jev
for *typed* decision-making, "instead of relying on fragile, open-ended
conversational LLM parsing". A generic `call_jev(prompt)` tool would throw
that away. So: **one tool per jev primitive, fixed schema** —
`classify_offer` (choice), `assess_frictions` (noul), `score_viability`
(score). The model chooses *which decision to make*, never *how to phrase the
jev call*.

The jev **transport** (`JevClient` with `choice`/`noul`/`score`) belongs in
`emw-lib` next to `AlfredClient` (same injectable `fetch`, same error style);
the jev **tools** stay in `emw`, because they need the DB to build `context`.

> Open: jev's actual API is not in the workspace — only the prose in
> `hunting.md`. `JevClient` waits until the endpoint shapes are confirmed.

## 10. Generic chat (`src/lib/alfred/transcript.ts`, `Chat.svelte`)

The minimal interface any frontend mounts. `emw`'s `AgentChat.svelte` adds
the drawer, entity badges, context chip and `draftPatch` apply on top —
never forked here.

- **`transcript.ts` (framework-free).** `ChatMessage`
  (`{ id, role: user|assistant|tool|system, text, seq?, pending?, thought? }`)
  plus three pure helpers: `historyToMessages` (durable `message` + `event`
  items, never deltas), `eventsToMessages` (live durable events, deltas
  skipped — they surface through the streaming draft), `buildTranscript`
  (history + live + optional `StreamingDraft` as pending bubble(s); thought
  draft only when `showThought`). Ids use the array index — the same durable
  event can appear twice (history + SSE replay) and `seq` alone would collide
  in a keyed `{#each}`.
- **`Chat.svelte` (`AlfredChat`).** Owns its `ButlerSession` (never a module
  singleton — same SSR rule as §5), creates or attaches on mount, renders the
  transcript (`role="log"`, `data-testid` hooks, empty state), a labelled
  composer (Enter sends, Shift+Enter newline, disabled until the session
  exists), `role="alert"` errors, and a status line. Props are
  construction-time config (`credential`, `agent`, `toolset`,
  `initialPrompt`, `sendMode`) — a remount picks up new values;
  only `showThought`/`placeholder`/`onerror` stay live.
  `sessionId` is `$bindable`: `null`/`undefined` → create + write the id back
  (persist it: chat row, URL, …); an id → attach + recover history instead of
  creating. Read once at start — a different chat needs a remount.
  Unstyled domain-wise:
  layout + `alfred-chat-*` classes only, no design system.
- **Barrel.** `index.ts` exports `AlfredChat` (`Chat.svelte` default) and
  `transcript.ts`; `ChatTestHost.svelte` is test-only and stays unexported.
