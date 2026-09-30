# Workflows (`src/lib/workflows/`)

One workflow = one async function. `await` points are step boundaries;
ticks replay the function from the journal and suspend at the first open
interaction. This file + `wf-creation.md` are self-contained: an agent can
write, register, wire and check a workflow from these two files alone.

## Authoring

```ts
export async function myWorkflow(
  { createSession, all, use, once, now, parseJson, log }: WFContext,
  input: WFInput,
): Promise<WFOutput> { ... }
```

| Need | Call |
|---|---|
| LLM, free text | `await session.prompt('label', text)` → `string` |
| LLM, structured | `await session.prompt('label', text, { expectedSchema: S })` → `T` |
| Tool | `await use.toolName(input)` (typed from `ToolRegistry`) |
| Fan-out | `await all(items.map((i) => use.toolName(i)))` |
| Session | `const session = await createSession({ ... })` |
| Cached value / clock | `once('key', () => …)` / `now()` (§2.3) |
| Prose+JSON answer | `parseJson(raw, S)` (pure; `ParseError` on failure) |
| Progress line | `log('message', data?)` |

- Schemas are `SchemaLike` (`{ safeParse }`), declared once: embedded in
  the prompt as JSON Schema, validated on resolve. Same source of truth.
  zod satisfies `SchemaLike` structurally (`z.ZodType<T>`), so zod hosts
  pass their schemas directly and embed via `z.toJSONSchema(S)`; zod-free
  hosts hand-roll the contract (see `marketAnalysis.ts`).
- `label` is a stable debug/i18n key (`'terms'`, `'rank'`). Identity is
  the call index, not the label.
- W-I sessions arrive as `Session` objects; workflow code never sees a uuid.
- Export `describeStep({ label, kind, tool?, inputSummary? })` → one
  English sentence. Display-only, cached as `label_text`; FE keys
  translations on `label`.

## Rules (violations are step errors)

1. **Resolved args only.** `await` before passing; never pass a `Promise`.
2. **One live `prompt` per session.** `await` the first answer before
   opening the second on the same session.
3. **Deterministic.** No `Date.now()` / `Math.random()` / `fetch` / ambient
   I/O outside `once`. Pure compute (`sort`, `filter`, `flatMap`,
   `JSON.*`, `safeParse`) is free and re-runs every tick.
4. **Always `await`** every `use.*` / `session.prompt` (directly or via
   `all`). Floating handles are unhandled rejections (linted).
5. **`catch` must rethrow control-flow sentinels.** `Suspend`/`StepError`
   are non-`Error` sentinels (`isControlFlow`); swallowing one is
   `error('swallowed_sentinel')`. `InteractionFailed` and `ParseError`
   are normal `Error`s and may be caught for local fallback.

## Execution (what the driver does)

- Tick = load journal → `resolveExpiries` → re-execute from the top →
  `done` / `waiting` / `error` / `cancelled`. Separate Vercel invocations
  only across resolutions. Cost: O(N) invocations, O(N²) replayed awaits
  for N interactions; a workflow-defined tool costs 3 invocations.
- Journal key: integer `idx`, row id `{run_id}:{idx}`. Memo rows live
  under `memo:{run_id}:{key}` and never consume an `idx`.
- Open + `nextIndex` bump commit in one TX. Allowed row mutations:
  `open → resolved | failed | cancelled | expired`.
- `wf.all` is fail-fast with sentinel precedence (`StepError` >
  `Suspend`); bare `Promise.all` inherits the same collection.
- Budgets: `maxOpens` (50), `maxBytes` (5MB, incl. memo bytes),
  `maxWallMs` (24h) + in-tick guard `tickMaxMs` (30s) → `tick_timeout`.
- Cancel → terminal `cancelled` (distinct from `error`).

## Versioning (deployment pinning)

- No definition hash. Each run stores `deployment_url` (opener's
  `VERCEL_URL`); every continuation (FE commands, Alfred callbacks,
  evolution notifications) routes to it, never to HEAD.
- Alfred takes a webhook/evolution-notify URL per generation.
- Stale deployments keep running (higher failure odds) with a durable
  `version_stale` stream event for the FE warning. Pruned deployment →
  `error('deployment_gone')` written through HEAD.

## Stream events

`interaction_opened { idx, kind, tool?, label, label_text }` /
`interaction_resolved { idx, status }`, `run_status`, `human_question` /
`human_answer` (verbatim), `version_stale`, `log`. Transport per the
generation-stream shape (SSE + `poll`, `after_seq` replay).

## Files

| File | What |
|---|---|
| `types.ts` | `ToolFn`, `ToolRegistry`, `ToolFns`, `Session`, `WFContext`, `DescribeStepArgs`, `ParseError`, `InteractionFailed`, `isControlFlow` |
| `index.ts` | Client-safe barrel (explicit names — `FetchFn` collision rule) |
| `server.ts` | Server-only barrel (`emw-lib/workflows-server`): driver + journal + checks |
| `define.ts` | `defineAsyncWorkflow(fn, meta)` → `{ name, version, fn, describeStep, outputSchema? }` |
| `driver.ts` | `tick(runId, deps)` — replay/suspend core, budgets, cancel, staleness |
| `journal.ts` | `openInteraction` (atomic TX), `resolveInteraction` (open-only), `resolveExpiries`, `cancelRun`, `markDeploymentGone`, memos, logbook |
| `parseJson.ts` | Extraction ladder (clean → fences → balanced-extract → `safeParse`) |
| `memo.ts` | `fnSourceHash` / `stableStringify` / `payloadHash` |
| `check.ts` | `checkWorkflow(src)` — exhaustiveness (9.2) + determinism (9.3) lints |

## Rules for contributors

- Client-safe: no `node:` imports, no env reads in `types.ts`/`parseJson.ts`/`memo.ts`/`check.ts`/`define.ts`.
- `defineAsyncWorkflow(fn, meta)` registers `{ name, version, fn, describeStep, outputSchema? }`. Duplicate `name@version` throws.
- Workflow files: `checkWorkflow(src)` flags missing-`return` paths (9.2) and `Date`/`Math.random`/`fetch`/DB imports outside `once` (9.3). The runtime W-O `outputSchema` check in `tick()` covers the taken branch.
- `svelte-check` 0 errors / 0 warnings; `biome check` clean; `test:unit` green.

## Host wiring (starter + tick route)

The lib owns the engine; the host owns tables, env, routes and Alfred I/O.

1. **Tables**: copy `emw/migrations/0017_workflows.sql` into the host's `migrations/` (forward-only, `IF NOT EXISTS`).
2. **Starter** (creates the run, pinned to this deployment):

```ts
import { createRun } from 'emw-lib/workflows-server'
import { getAsyncWorkflow } from 'emw-lib'
import { env } from '$env/dynamic/private'
import './workflows/marketAnalysis.js' // populate the deploy-time registry

const run = await createRun(
  {
    workflowName: 'marketAnalysis',
    workflowVersion: 1,
    inputJson: input,
    deploymentUrl: env.VERCEL_URL ?? 'http://localhost:5173',
    prodDeploymentUrl: env.VERCEL_PROJECT_PRODUCTION_URL ?? '',
  },
  sql
)
// Return `run.id` + `run.deployment_url` — every continuation routes to it.
```

3. **Tick route** (`POST /api/workflows/[runId]/tick`, `maxDuration: 60`):

```ts
import { getAsyncWorkflow } from 'emw-lib'
import { tick } from 'emw-lib/workflows-server'
import { AlfredClient } from 'emw-lib'
import { env } from '$env/dynamic/private'
import '../workflows/marketAnalysis.js'

const alfred = new AlfredClient({ baseUrl: env.BUTLER_URL, webhookSecret: env.ALFRED_WEBHOOK_SECRET })
// Pinned webhook base: continuations + Alfred callbacks route here, never HEAD.
const pinnedBase = (deploymentUrl: string) => deploymentUrl.replace(/\/$/, '')
const result = await tick(runId, {
  sql,
  lookupWorkflow: (name, version) => getAsyncWorkflow(name, version),
  postSession: (i) => alfred.createSession({ agent: { model: i.model, system_prompt: i.systemPrompt }, toolset: i.toolset }).then((r) => r.session_id),
  runTool: async (tool, input) => {
    /* enqueue `execute` on the pinned deployment; resolution writes via resolveInteraction */
  },
  prodDeploymentUrl: env.VERCEL_PROJECT_PRODUCTION_URL ?? undefined,
  onEvent: (e) => {
    if (e.type === 'interaction_opened' && e.kind === 'prompt') {
      // Host-owned: POST the generation to Alfred with the run's pinned
      // deployment as webhook_url (the driver never POSTs prompts itself).
      // void alfred.prompt(sessionId, { prompt, webhook_url: `${pinnedBase(run.deployment_url)}/api/workflows/${runId}/resolve` })
    }
    streamPublish(runId, e)
  },
  persistEvent: (e) => streamPersist(runId, e),
})
```

4. **Prompt resolution** (Alfred generation webhook): run the §2.2 ladder + `expectedSchema.safeParse` over the terminal answer, then `resolveInteraction(runId, idx, { status: 'resolved', output } | { status: 'failed', error })`. Emit `interaction_resolved` + `human_*`/`log` on the host transport.
5. **Pinning**: FE play/pause/cancel, tool webhooks and evolution notifications all POST to `run.deployment_url`, never HEAD. Stale runs emit `version_stale` and continue; pruned deployments get `error('deployment_gone')` via `markDeploymentGone` through HEAD.
6. **Vercel hardening**: bypass tokens for protected deployments, CORS for FE→deployment host, pruning-retention policy (all three before §8 is real in preview).
