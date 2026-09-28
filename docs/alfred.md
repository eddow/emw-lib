# Alfred client (`src/lib/alfred/`)

TypeScript client for the Butler (`butler/alfred.md`, FastAPI on `:8192`).
Design doc: `plans/alfred-client.md`. Protocol: `butler/alfred.md`.

## Layering

```
types.ts ──► client.ts ──► stream.ts ──► transcript.ts
   │              │             │               │
   │              ▼             ▼               ▼
   │        AlfredClient  applyLiveEvent  historyToMessages
   │        AlfredError   StreamState     eventsToMessages
   │                                     buildTranscript
   ▼
session.svelte.ts (ButlerSession, runes) ──► Chat.svelte (AlfredChat)
```

The core (`types`, `client`, `stream`, `transcript`) is framework-free and
runs in browser + node. Only `session.svelte.ts` (runes) and `Chat.svelte`
are Svelte-aware.

## Auth: the credential travels as one object

```ts
import { AlfredChat, type AlfredCredential } from 'emw-lib'

const credential: AlfredCredential = { token, expires_at, base_url } // from emw's token route
```

- The browser never hardcodes a host and never reads env. `emw` mints
  `{ token, expires_at }` from Alfred (`POST /sessions/{id}/token` with
  `X-Alfred-Secret`) and attaches its own `base_url` (`env.ALFRED_PUBLIC_URL`).
- `AlfredClient.setCredential()` swaps token + URL atomically;
  `ButlerSession.refreshToken` may return `string | AlfredCredential` and is
  retried once on `401`.
- Server-side callers leave the token unset and use `X-Alfred-Secret`.

## Chat: `sessionId` is bindable (create-or-recover)

```svelte
<AlfredChat credential={{ token, base_url }} agent={{ model }} bind:sessionId={chatSessionId} />
```

- `sessionId` starts `null`/`undefined` → the chat `POST /sessions`, writes
  the new id back through the binding (persist it: chat row, URL, …), then
  attaches the SSE stream.
- `sessionId` holds an id → the chat attaches + `loadHistory()` instead of
  creating. History renders from Alfred's `/history`; the stream resumes from
  the durable cursor.
- A later parent change means "a different chat" — remount, don't silently
  switch (the prop is read once at start).

## Files

| File | Tests |
|---|---|
| `types.ts` — wire contract (snake_case keys), `AlfredCredential` | — |
| `client.ts` — `AlfredClient` + `AlfredError`, SSE parser, `pollLoop` | `client.test.ts` |
| `stream.ts` — `applyLiveEvent` reducer, `lastSeq` cursor | `stream.test.ts` |
| `transcript.ts` — history/events → `ChatMessage[]` | `transcript.test.ts` |
| `session.svelte.ts` — `ButlerSession` lifecycle shell | `session.svelte.test.ts` |
| `Chat.svelte` — `AlfredChat` minimal chat | `Chat.svelte.test.ts` (+ `ChatTestHost.svelte`, test-only) |

## Rules for contributors

- Never a module-level singleton (`$state` at module scope leaks across SSR).
- Explicit `attach()` / `dispose()` — `$effect` only runs in a component.
- `ButlerSession` reuses `applyLiveEvent`; never a second delta/final/cursor
  implementation.
- Deltas are ephemeral: never persisted, never messages, cursor from durable
  `seq` only.
- Transcript ids use the array index — the same durable event can appear via
  both history and SSE replay, and `seq` alone would collide in `{#each}`.
