# wf-creation — how to write an asyncWF workflow

Agent-targeted. Self-contained with `README.md` in this folder: no other
file needed. One workflow = one async function.

---

## 1. Shape

```ts
export type WFInput = { /* W-I */ };
export type WFOutput = /* W-O */;

export async function myWorkflow(
  { createSession, all, use, once, now, parseJson, log }: WFContext,
  input: WFInput,
): Promise<WFOutput> { ... }
```

- Destructure the context on the parameter line (house style).
- `await` points are step boundaries. Everything between them re-runs on
  every tick — keep it pure.
- Return the W-O value. Every code path must `return` or `throw`.

## 2. Declare schemas once (`SchemaLike`)

```ts
// zod host: z.ZodType<T> satisfies SchemaLike<T> structurally.
const Terms = z.array(z.object({ language: z.string(), terms: z.array(z.string()) }));
type Terms = z.infer<typeof Terms>;
```

- The schema is the single source of truth: it validates the answer
  **and** is exported as JSON Schema for the prompt (zod hosts: via
  `z.toJSONSchema(Terms)`; zod-free hosts: hand-roll `{ safeParse }` +
  a `jsonSchema` object — see `marketAnalysis.ts`).
- Declare tool payload types in the `ToolRegistry` (one place).

## 3. Call sites

| Need | Call |
|---|---|
| LLM answer, free text | `await session.prompt('label', text)` → `string` |
| LLM answer, structured | `await session.prompt('label', text, { expectedSchema: Terms })` → `Terms` |
| Tool | `await use.toolName(input)` (typed from `ToolRegistry`) |
| Fan-out | `await all(items.map((i) => use.toolName(i)))` |
| Session | `const session = await createSession({ ... })` |
| Prose+JSON answer | `parseJson(raw, Terms)` (see §6) |
| Progress line | `log('message', data?)` |

- Embed the schema in the prompt text:
  `JSON.stringify(z.toJSONSchema(Terms))` (zod) or the hand-rolled
  `jsonSchema` object.
- `label` is a stable debug/i18n key (`'terms'`, `'rank'`, `'summary'`).
  Not unique; identity is the call index.
- Non-determinism has one escape hatch: `once('key', () => …)` journals
  the value (replay returns it; source change is a step error) and
  `now()` is `once('now', () => Date.now())`. Clock/randomness inside
  `once` only.

## 4. Rules (violations are step errors)

1. **Resolved args only.** `await` before passing. Never pass a `Promise`.
2. **One live `prompt` per session.** `await` the first answer before
   opening the second on the same session. Different sessions parallelize.
3. **Deterministic.** No `Date.now()`, `Math.random()`, `fetch`, ambient
   I/O outside `once` (checked by `checkWorkflow`). Clock/randomness go
   inside `once('key', () => …)` so they journal; HTTP goes through
   `use.*`. Pure compute (`sort`, `slice`, `filter`, `flatMap`,
   `JSON.parse`, `safeParse`) is free.
4. **Always `await`** every `use.*` / `session.prompt` (directly or via
   `all`). A floating handle is an unhandled rejection.

## 5. Control flow

- `if` / `switch` / `for` / `while` / early `return` are plain JS.
- Loops are fine: iteration count must be a pure function of resolved
  values (it is, if rule 3 holds).
- `try/catch` may catch `InteractionFailed` (a resolved tool error) or
  `ParseError` for local fallback.
- **Never swallow control-flow sentinels.** `Suspend` / `StepError` are
  non-`Error` sentinels; a `catch` MUST rethrow anything passing
  `isControlFlow(e)`. Swallowing one is `error('swallowed_sentinel')`.

## 6. Structured answers

- Prefer `{ expectedSchema }` — the runtime extracts + validates on
  resolve, and the journal stores structured data.
- Use `parseJson(raw, Schema)` when the model returns prose/fenced JSON
  and you want retry in workflow code. It is pure and deterministic:
  `JSON.parse` → strip fences → extract first balanced `{…}`/`[…]` →
  `safeParse`. Throws `ParseError` (catchable, not a sentinel).
- A retry is a **new** interaction (new idx) — deterministic, because the
  first parse fails identically on every replay.

## 7. Human feedback (`describeStep`)

Export a pure `describeStep({ label, kind, tool?, inputSummary? })`
returning one English sentence. It is display-only (never replay
identity), computed once at open time and cached as `label_text`. The FE
keys translations on `label`.

## 8. Checklist before submitting

- [ ] W-I / W-O types exported; every path returns W-O.
- [ ] Every schema declared once (`SchemaLike`); JSON Schema embedded in prompts.
- [ ] Tool names exist in `ToolRegistry`; payloads typed.
- [ ] No `Date`/`Math.random`/`fetch`/ambient I/O outside `once`.
- [ ] Every `use.*` / `prompt` awaited.
- [ ] No two live prompts on one session.
- [ ] `catch` blocks rethrow control-flow sentinels (`isControlFlow`).
- [ ] `describeStep` exported and pure; `outputSchema` registered for W-O.
- [ ] Labels are stable, human-readable keys.
- [ ] `checkWorkflow(src)` clean.

## 9. Reference

- Worked examples: `arb2b/src/lib/server/workflows/marketAnalysis.ts`
  (linear: fan-out, structured prompts, pure pipelines, `parseJson`
  variant) and `triagePages.ts` (branching + looping + per-element
  fallback + early return + `once` checkpoint).
- Registration: `defineAsyncWorkflow(fn, { name, version, describeStep,
  outputSchema? })` — duplicate `name@version` throws. The tick
  validates the return value against `outputSchema` before `done`.
- Static checks: `checkWorkflow(src)` (exhaustiveness + determinism).
  Host wiring (starter, tick route, pinning): `README.md` in this folder.
