## Specifications — dynamic chat

### 0. Scope

`AlfredChat` in `Chat.svelte` + `GenerationStream` in `session.svelte.ts` + `ChatPane.svelte` in `agent` + stream route `+server.ts`.

Out of scope: history persistence, tool execution, markdown rendering.

### 1. Defects to specifications

**B1 — prompt answer requires refresh.**

Invariant: after `onsend()` resolves with a `StreamCredential`, the new generation's `answer_delta` / `answer` frames render without reload or remount.

Suspected cause: `ChatPane.svelte` sets `generationId` in `onsend()` but not `credential`. The `{#key chatId:generationId}` remounts `AlfredChat` with the stale `credential` prop, disposing the just-`attach()`ed stream in `Chat.svelte:send()`. Reload works because `load` re-fetches `/history`.

Spec: credential ownership must be single-source. Either update `credential` state on `onsend`, or remove `generationId` from the `{#key}`, or make `credential` a live prop instead of construction-time `initial`.

**B2 — settled thought stays expanded.**

Invariant: live `thought` renders expanded (`alfred-thought-live`, `data-pending=true`); durable `thought` renders collapsed (`alfred-thought-settled` `<details>`, one-liner `💭 Thoughts`).

Suspected causes:

1. `stream.thought` is replaced, never cleared, on durable `thought` in `stream.ts:applyLiveEvent`. `buildTranscript()` then emits both the durable message and the `streaming-thought` pending bubble.
2. No cross-boundary pairing: `transcript.ts:buildTranscript` pairs inside history and inside live events separately, never across. A `tool_use` from history + `tool_result` from live stays pending.

Spec: define draft lifetime — durable final supersedes and clears the pending draft; pairing/dedup must handle history/live boundary.

### 2. Controllable mock chatbot (e2e harness)

No live OpenRouter, no live Butler in e2e.

* Intercept at `fetch` level: `POST /agent/stream` (returns scripted `StreamCredential`) and `GET <stream_url>?after_seq=N` (returns scripted SSE).
* Harness exposes step control to the test: `emit(frame)`, `hold()`, `close()`, `fail(status, detail)`.
* Frame primitives: `thought_delta`, `thought`, `answer_delta`, `answer`, `tool_use`, `tool_result`, `human_question`, `human_answer`, `done(reason)`, `error(text)`.
* Existing pattern to reuse: `Chat.svelte.test.ts:installFetch()` + `ChatTestHost.svelte`. E2e version uses Playwright `page.route()` instead of `globalThis.fetch` mock, same frame builders.
* Location: `*.e2e.ts` per `playwright.config.ts` (`testMatch: **/*.e2e.{ts,js}`, preview on `:4173`). No new test runner.

### 3. Send-mode matrix

`ChatSendMode = prompt | queue | steer | interrupt`. `effectiveMode` rule in `Chat.svelte` stays: idle → `prompt` only; live (`streaming`/`waiting`/`paused`) → `queue`/`steer`/`interrupt`; invalid picks clamp.

| #   | Start state                               | Action                                 | Stream-route call                                     | `onsend` returns                   | Expected UI                                                                                         |
| --- | ----------------------------------------- | -------------------------------------- | ----------------------------------------------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------- |
| S1  | idle, `credential=null`                   | Enter `prompt`                         | `mode:prompt` → `PromptResult`                        | new credential                     | `attach()`; `answer_delta` renders pending bubble spontaneously; `done:stop` settles, composer idle |
| S2  | live streaming                            | Enter (default `queue`)                | `mode:queue` → `{ok,generation_id}` or `PromptResult` | `null` (same stream) or credential | stays attached; injected prompt visible after echo; no remount, no stream drop                      |
| S3  | live                                      | Ctrl+Enter `steer`                     | `mode:steer` → `{ok:true}`                            | `null`                             | stays attached; status stays `streaming`                                                            |
| S4  | live                                      | Alt+Enter `interrupt`                  | `mode:interrupt` → `{ok:true}`                        | `null`                             | in-flight draft superseded; new deltas render                                                       |
| S5  | live                                      | Esc / Stop                             | `onstop()` + local `dispose()`                        | —                                  | loop aborted, `sending=false`, composer usable, transcript kept                                     |
| S6  | live                                      | `prompt` while live                    | BE `409 + active_generation_id`                       | `play()` credential                | attaches live generation, no duplicate transcript (dedup by `(type,seq,payload)`)                   |
| S7  | terminal `done:max_iterations` or `error` | Keep/Try-again                         | `onretry(msgId)` → re-prompt/resume                   | credential or `null`               | `RetryBox` dismisses; new run streams; snail countdown only when `parseRetryAfterS` matched         |
| S8  | `waiting` (`human_question`)              | answer card submit                     | `POST <stream_url>/answer/<call_id>` direct to Alfred | —                                  | card disables, receipt renders, status back to `streaming`                                          |
| S9  | reload mid-generation                     | mount with `history` + `status`→`play` | `mode:status` then `mode:play`                        | credential                         | history renders immediately; SSE replay from `after_seq=0` deduplicated, no doubles                 |

Error paths: `onsend` throw → `stream.error` + `role=alert`, composer kept (existing `alfred-chat-error` behavior). SSE `410/401` → `refreshStream` (`play`) once, else `status=error`.

### 4. UI transition assertions (per scenario)

* U1 answer: first `answer_delta` creates `alfred-chat-message[data-role=assistant][pending]`; durable `answer` replaces draft (no duplicate bubble).
* U2 thought: deltas → `alfred-thought-live` expanded, `max-height` scroll; durable `thought` → exactly one `alfred-thought-settled` collapsed one-liner; no residual live block.
* U3 tool: unpaired `tool_use` → `alfred-tool-live` expanded + `data-pending=true`; paired `tool_use→tool_result` (same `tool_call_id`, either order, either boundary) → single `alfred-tool-settled` collapsed with args/output in `<details>`.
* U4 terminal: `done:stop` → nothing; `done:superseded|archived` → `alfred-status-line`; `done:max_iterations`/`error` → `alfred-retry-box` with Keep/Try-again + Dismiss; rate-limit text → `🐌` countdown then auto-`onretry`.
* U5 scroll: stick-to-bottom only when already at bottom (`scrollHeight - scrollTop - clientHeight < 48`); history readers never yanked.
* U6 composer: disabled while `sending`; usable while streaming (for queue/steer/interrupt); Stop visible iff `isStreaming || sending`.

### 5. E2e control protocol

Each scenario test:

1. Load host with scripted `onsend` returning harness-controlled credential.
2. `harness.emit(thought_delta × N)` → assert `alfred-thought-live` visible, expanded.
3. `harness.emit(thought)` → assert live block gone, exactly one `alfred-thought-settled` collapsed.
4. `harness.emit(answer_delta × N)` → assert pending answer bubble grows spontaneously (no reload, no navigation).
5. `harness.emit(answer)` + `done` → assert settled answer, composer state per §3.
6. Same stepwise pattern for tool pair, `human_question`→`human_answer`, `error`→retry→continue, `interrupt`/`steer` mid-delta.

Deterministic waits: `expect.element(...).toBeVisible()` / `toHaveTextContent()`, never fixed sleeps. Snail case uses mocked timers.

### 6. Acceptance

* S1–S9 scripted against the mock, all green in `pnpm exec playwright test`.
* B1 repro (idle prompt → spontaneous answer) and B2 repro (thought expand → collapse) fail before the fix, pass after.
* Existing `client` (`*.svelte.test.ts`) + `server` suites stay green; `expect.requireAssertions` holds.
