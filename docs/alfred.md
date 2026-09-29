# Alfred client (`src/lib/alfred/`)

TypeScript client for the Butler (`butler/docs/alfred.md`, FastAPI on `:8192`).
Protocol: `butler/docs/alfred.md`.

## Layering

```
types.ts ──► client.ts ──► stream.ts ──► transcript.ts
   │              │             │               │
   │              ▼             ▼               ▼
   │        AlfredClient  applyLiveEvent  historyToMessages
   │        AlfredError   StreamState     eventsToMessages
   │                                     buildTranscript
   ▼
session.svelte.ts (GenerationStream, runes) ──► Chat.svelte (AlfredChat)
```

The core (`types`, `client`, `stream`, `transcript`) is framework-free and
runs in browser + node. Only `session.svelte.ts` (runes) and `Chat.svelte`
are Svelte-aware.

## Auth: BE secret vs stream capability

Two credentials, two planes — never mixed:

- **BE** (`X-Alfred-Secret` via `webhookSecret`): every control call
  (`createSession`, `prompt`, `play`, `stop`/`resume`/`queue`/`steer`/
  `interrupt`, `getSession`/`listSessions`/`deleteSession`, `history`,
  `backup`). Server-side only; the browser never holds it.
- **FE** (stream capability via `streamToken`): `streamEvents` / `streamPoll`
  on `/streams/{gid}` only. Short-lived HMAC (`generation_id.exp`, default
  600s), valid while the generation is live (`running` or `paused`), dead on
  `done`/`error`.

```ts
import { AlfredChat, type StreamCredential } from 'emw-lib'

// BE forwards its prompt/play response over its own priv channel:
const credential: StreamCredential = { generation_id, stream_token, stream_url }
```

- The browser never hardcodes a host and never reads env. `stream_url` is
  informational (`{ALFRED_PUBLIC_URL}/streams/{gid}`); the token, not the
  host, is the secret — and `stream_url` NEVER embeds the token.
- `AlfredClient.setStreamCredential()` swaps token + base URL atomically
  (strips the `/streams/{gid}` suffix for the base);
  `GenerationStream.refreshStream` re-mints via the BE's `play` and is
  retried once on `401`/`410`.
- `setStreamToken()` swaps just the token; `setWebhookSecret()` swaps the BE
  secret. Either accepts `undefined` to clear (local dev).

## Tool serving: the generation owns the webhook URL

```ts
import { toToolset } from 'emw-lib'
import { createWebhookHandler } from 'emw-lib/alfred-server'

const toolset = toToolset(tools, { max_iterations: 5 }) // URL-free callbacks
const handler = createWebhookHandler({
  tools,
  webhookSecret: process.env.ALFRED_WEBHOOK_SECRET,
  resolveScope: async (sessionId) => lookupScope(sessionId),
})
```

- Alfred POSTs every `callback` tool call to the generation's `webhook_url`
  (from `prompt`, see `butler/docs/alfred.md` §2.1); dispatch is by payload `name`,
  correlation by `session_id` + `generation_id` + `tool_call_id`. There is no
  env-owned webhook URL and no per-tool `execution.url` for `callback`.
- `toToolset` emits URL-free callbacks (no `urlOverride` param — removed).
  Callback tools MUST be idempotent (read-only lookups by contract).
- `createToolHandler` verifies → executes INLINE → returns `{result} |
  {error}` in the POST response itself (`200`; malformed → `400`, bad secret
  → `401`). No `202`, no `waitUntil`, no claim/dedupe, no PUT-back.
  `createWebhookHandler` pre-wires the secret check around it; `server.ts` is
  server-only (never the browser barrel). `ToolScope` carries
  `generationId` alongside `sessionId`/`toolCallId`.

## Tool selection: hard-coded builtins + webhook-defined callbacks

```ts
import { BUILTIN_GENERIC, toMixedToolset } from 'emw-lib'

const toolset = toMixedToolset({
  callbackTools: agentTools, // host-owned, `execution.type: 'callback'`
  builtinDefs: BUILTIN_GENERIC, // hard-coded, `execution.type: 'builtin'`
  policy: { max_iterations: 5 },
})
```

- Hard-coded tools (Alfred executes in-process, no keys) are listed with
  their metadata (description + JSON Schema arguments) in `builtins.ts`
  (`BUILTIN_GENERIC` for `docs/tools.md` §3, `BUILTIN_SPECIALISED` for §4).
  Select them by descriptor alongside the webhook-defined `callback` tools —
  `toMixedToolset` emits one `ToolDef[]` with both `execution` types (a
  `callback` shadows a builtin of the same name).
- `GET /tools` (`AlfredClient.listTools()`, BE-only) is the live source of
  truth for the same catalogue — prefer it when Alfred is reachable, fall
  back to the static mirror for offline selection. Butler serves it from
  `src/alfred/builtins/specs.py` (single source of truth, covered by
  `test_tool_specs_match_handlers`); keep the mirror in sync when adding a
  builtin.

## Chat: stream-only (`GenerationStream` + `onsend`)

```svelte
<AlfredChat credential={{ generation_id, stream_token, stream_url }} onsend={send} />
```

- The component owns a `GenerationStream` (never a module singleton — `$state`
  at module scope leaks across SSR). It attaches the credential on mount and
  renders the transcript from live stream events.
- Sending goes browser → APP action (`onsend(prompt)` → per-policy APP call)
  → new credential back (or `null` to stay on the current stream). The
  component never creates/prompts/steers directly — the APP owns
  `AlfredSession` (BE-side), the FE owns the stream.
- A later parent change means "a different generation" — remount, don't
  silently switch (props are construction-time config; only `showThought` /
  `placeholder` / `onerror` stay live).
- `ButlerSession` / `ButlerStatus` / `SendMode` survive as deprecated aliases
  of `GenerationStream` / `GenerationStatus` (`queue | steer | interrupt` —
  `redirect` is gone).

## Files

| File | Tests |
|---|---|
| `types.ts` — wire contract (snake_case keys), `StreamCredential`, `PromptInput/Result`, `PlayResult` | — |
| `client.ts` — `AlfredClient` + `AlfredError`, BE/stream split, SSE parser, `pollLoop` | `client.test.ts` |
| `stream.ts` — `applyLiveEvent` reducer, `lastSeq` cursor (generation-local) | `stream.test.ts` |
| `transcript.ts` — history/events → `ChatMessage[]` | `transcript.test.ts` |
| `session.svelte.ts` — `GenerationStream` lifecycle shell (+ `ButlerSession` alias) | `session.svelte.test.ts` |
| `Chat.svelte` — `AlfredChat` stream-only chat | `Chat.svelte.test.ts` (+ `ChatTestHost.svelte`, test-only) |
| `tools.ts` — `AgentTool`, `ToolScope` (+`generationId`), `toToolset`, `toMixedToolset`, `createToolHandler` | `tools.test.ts` |
| `server.ts` — `checkWebhookSecret`, `createWebhookHandler` | `server.test.ts` |

## Rules for contributors

- Never a module-level singleton (`$state` at module scope leaks across SSR).
- Explicit `attach()` / `dispose()` — `$effect` only runs in a component.
- `GenerationStream` reuses `applyLiveEvent`; never a second delta/final/cursor
  implementation.
- Deltas are ephemeral: never persisted, never messages, cursor from durable
  `seq` only (`seq` is generation-local, from 1 per generation; `stream_id`
  IS the `generation_id`).
- Transcript ids use the array index — the same durable event can appear via
  both history and SSE replay, and `seq` alone would collide in `{#each}`.
