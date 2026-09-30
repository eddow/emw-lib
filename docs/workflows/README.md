# Workflows (`src/lib/workflows/`)

One workflow = one async function. `await` points are step boundaries;
ticks replay the function from the journal and suspend at the first open
interaction. Full model: `plans/asyncWF/specs.md`.

## Authoring

```ts
export async function myWorkflow(
  { createSession, all, use, once, parseJson, log }: WFContext,
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

- Schemas are zod, declared once: embedded in the prompt via
  `z.toJSONSchema(S)`, validated on resolve. Same source of truth.
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
| `index.ts` | Barrel (explicit names — `FetchFn` collision rule) |
| `parseJson.ts` | Extraction ladder (clean → fences → balanced-extract → `safeParse`) |
| `describe.ts` | `describeStep` contract helpers (optional) |

## Rules for contributors

- Client-safe: no `node:` imports, no env reads in `types.ts`/`parseJson.ts`.
- `defineAsyncWorkflow(fn, meta)` registers `{ name, version, fn, describeStep }`.
- Workflow files: no `Date`/`Math.random`/`fetch`/DB imports outside `once`
  (linted); every path returns W-O (linted).
- `svelte-check` 0 errors / 0 warnings; `biome check` clean; `test:unit` green.
