/**
 * asyncWF tick driver — replay + suspend core
 * (`plans/asyncWF/specs.md` §§3–4; checklist Phases 2–3). Server-only:
 * import via `emw-lib/workflows-server`, never from browser code or the
 * client-safe barrel (same split as `emw-lib/db-server`).
 *
 * One tick = load run → `resolveExpiries` → re-execute the workflow
 * function from the top against a per-tick `WFContext` → persist the
 * outcome. The DB never holds a promise, only journal rows (specs §3.3).
 *
 * Covered here (Phases 2–6: replay/suspend, sessions, tools, structured
 * output, memo, logbook/stream vocabulary, budgets, cancel):
 * - Replay: `idx < nextIndex` MUST hit the journal; miss or kind/label/
 *   payload mismatch → `StepError` sentinel (`NonDeterminism`), never
 *   silent re-execution of a side effect (§3.2).
 * - Record: `describeStep` runs BEFORE the open TX (R3 — throw means the
 *   row is never committed); INSERT + `nextIndex` bump commit atomically
 *   via `openInteraction` (§3.3).
 * - Outcomes: every call site records into `ctx.outcomes[idx]` before its
 *   promise settles; collection precedence is `StepError > Suspend`
 *   (§3.6). `wf.all` is fail-fast on `InteractionFailed`; bare
 *   `Promise.all` inherits the same collection via the context.
 * - Success path: `swallowed_sentinel` guard (R0) — a tick that returns
 *   while opens are pending (user `catch` swallowed a sentinel) is a
 *   step error, never silent `done`.
 * - `InteractionFailed` (resolved tool/prompt error, uncaught) → run
 *   `error`; any other user-code throw → `error('workflow_throw')` (§3.1).
 * - Sessions (3.1–3.2): `createSession` POSTs on first tick through the
 *   injected `postSession`; POST failure marks the row `failed` +
 *   `StepError('session_create_failed')` (R1, terminal, never a wait).
 *   Replay returns a `Session` wrapping the stored id. The per-session
 *   semaphore (B2) lives on the `Session` object: a second live
 *   `prompt()` on the same receiver is a step error.
 * - Tools (4.1): `wf.use.*` wrappers built per tick from the deploy-time
 *   registry; `label` defaults to the tool name. Tool execution itself
 *   (4.2 scheduling, Alfred POST) is injected via `runTool` — this
 *   driver only opens/suspends/replays the journal rows.
 * - Memo (4.6-partial): `wf.once`/`wf.now` journal under `(run_id, key)`
 *   via `readMemo`/`writeMemo`, `fnSourceHash` validation, never consume
 *   an `idx`. `Date.now()`/`Math.random()` are allowed ONLY inside `fn`.
 *
 * Also here (Phases 7.1/7.3 + 9.2-runtime): registry lookup by
 * `workflow_name@version`, W-O `outputSchema` check before `done`, and
 * the `version_stale` staleness signal (emitted, run continues).
 *
 * NOT here: `interaction_resolved` / `human_*` / `log` stream emission
 * (resolver/host transport), Alfred generation POSTs + pinned-claim
 * routing (host wiring — the driver only emits `interaction_opened`;
 * see `docs/workflows/README.md` §§3–4), exhaustiveness +
 * determinism lints (`check.ts`, 9.2–9.3).
 */

import type {
	BasePromptOpts,
	ControlFlowSentinel,
	DescribeStepFn,
	SchemaLike,
	Session,
	ToolRegistry,
	WFContext,
	WFCreateSessionInput,
	WorkflowStreamEvent,
} from './index.js'
import {
	CONTROL_FLOW_TAG,
	extractJsonValue,
	fnSourceHash,
	InteractionFailed,
	isControlFlow,
	parseJson,
	payloadHash,
	stableStringify,
	throwControlFlow,
} from './index.js'
import {
	appendLogbook,
	getRun,
	type InteractionKind,
	listInteractions,
	openInteraction,
	readMemo,
	resolveExpiries,
	resolveInteraction,
	type WorkflowInteractionRow,
	type WorkflowMemoRow,
	type WorkflowRunRow,
	type WorkflowSql,
	writeMemo,
} from './journal'

/** Step-error codes surfaced as `error(<code>)` on the run row. */
export type StepErrorCode =
	| 'swallowed_sentinel'
	| 'NonDeterminism'
	| 'session_create_failed'
	| 'workflow_throw'
	| 'describeStep_throw'
	| 'once_hash_mismatch'
	| 'promise_arg'
	| 'session_double_prompt'
	| 'tick_timeout'
	| 'output_mismatch'
	| 'deployment_gone'
	| `budget_exceeded:${'maxOpens' | 'maxBytes' | 'maxWallMs'}`

/** Per-call-site outcome recorded before its promise settles (§3.6). */
export type CallOutcome =
	| { kind: 'value'; value: unknown }
	| { kind: 'failed'; error: InteractionFailed }
	| { kind: 'suspend'; idx: number }
	| { kind: 'step-error'; code: string; idx?: number }

/**
 * Resolve-time structured-output validation (specs §2.2, checklist 4.4):
 * run the §2.2 extraction ladder over the raw answer, then
 * `schema.safeParse`. Returns the typed value on success; throws
 * `InteractionFailed` (a normal, catchable `Error` — per-element
 * fallback works) carrying the idx/kind/label on validation failure.
 * Never a sentinel: the row resolves `failed`, the tick maps it to run
 * `error` only when uncaught (§3.1).
 */
export function validateStructuredAnswer<T>(
	raw: unknown,
	schema: { safeParse(d: unknown): { success: boolean; data?: T } },
	site: { idx: number; kind: string; label: string }
): T {
	let value: unknown
	try {
		value = typeof raw === 'string' ? extractJsonValue(raw) : raw
	} catch (e) {
		throw new InteractionFailed(e instanceof Error ? e.message : String(e), site)
	}
	const res = schema.safeParse(value)
	if (res.success) return res.data as T
	throw new InteractionFailed(
		`answer does not match schema: ${JSON.stringify((res as { error?: unknown }).error ?? null).slice(0, 500)}`,
		site
	)
}

/** Mutable per-tick driver state behind the `WFContext` facade. */
export interface TickState {
	runId: string
	journal: Map<number, WorkflowInteractionRow>
	nextIndex: number
	counter: number
	outcomes: Map<number, CallOutcome>
	describeStep: DescribeStepFn
	sql: WorkflowSql
	postSession: (input: WFCreateSessionInput) => Promise<string>
	/** Enqueue-only: the return value is ignored (resolution arrives via the journal). */
	runTool: (tool: string, input: unknown) => Promise<void>
	/**
	 * Opens reserved/committed this tick. Entries with
	 * `kind === '__reserve__'` are budget slots held by an in-flight
	 * open (gate ran, TX not yet committed) — replaced with the real
	 * entry on commit. `TickResult.opened` filters them out.
	 */
	pendingOpens: { idx: number; kind: InteractionKind | '__reserve__'; label: string }[]
	logLines: { label: string; idx: number | null; message: string; data?: unknown }[]
	/** Tick-scoped memo cache: key → row (read once per tick, specs §2.3). */
	memos: Map<string, WorkflowMemoRow | null>
	/** Memo write-backs queued this tick (flushed before persist). */
	memoWrites: { key: string; fnHash: string; output: unknown }[]
	/** Budget limits for this tick (specs §7; defaults per `TickDeps`). */
	maxOpens: number
	maxBytes: number
	maxWallMs: number
	/** Wall-clock start of the run (ms epoch; `maxWallMs` deadline). */
	runStartedAt: number
	/** Persisted `bytes_used` at tick start; the gate adds this tick's fresh bytes (specs §7). */
	baseBytes: number
	now: () => number
	/** Pre-fixed `ask-human` answers by label (specs §5, `-y`). */
	prefixedAnswers: Record<string, unknown>
	/** Best-effort stream sink (specs §3.5, checklist 5.2). */
	onEvent?: (event: WorkflowStreamEvent) => void
}

export interface TickDeps {
	/**
	 * Host Neon client (required — the lib never imports the host's
	 * `db.ts`; same rule as `AuthEnv`/`AuthDb` in `emw-lib/auth-server`).
	 */
	sql: WorkflowSql
	/** Alfred `POST /sessions` → session id (injected; R1 failure path tested). */
	postSession?: (input: WFCreateSessionInput) => Promise<string>
	/**
	 * Tool execution for fresh opens (injected; Phase 4.2 wires Alfred).
	 * Enqueue-only: the return value is ignored — resolution arrives via
	 * the journal on a later tick.
	 *
	 * Prompt generations are NOT posted by the driver: the host observes
	 * `interaction_opened` (`kind: 'prompt'`) and POSTs the generation to
	 * Alfred with the run's pinned `deployment_url` as `webhook_url`
	 * (host wiring §§3–4 in `docs/workflows/README.md`).
	 */
	runTool?: (tool: string, input: unknown) => Promise<void>
	/** Workflow function under test (injected so tests skip the registry). */
	workflowFn?: (wf: WFContext<ToolRegistry>, input: unknown) => Promise<unknown>
	/**
	 * Registry lookup (Phase 7): when `workflowFn` is absent, the tick
	 * resolves the run's `workflow_name@version` through this. Hosts pass
	 * `getAsyncWorkflow` from `emw-lib` (the starter imports the workflow
	 * modules so the deploy-time map is populated). Tests inject
	 * `workflowFn` directly and skip the registry.
	 */
	lookupWorkflow?: (
		name: string,
		version: number
	) =>
		| {
				fn: (wf: WFContext<ToolRegistry>, input: unknown) => Promise<unknown>
				describeStep?: DescribeStepFn
				outputSchema?: SchemaLike<unknown>
		  }
		| undefined
	/**
	 * W-O return-value schema (specs §3.1, checklist 9.2): the tick
	 * validates the workflow's return value before persisting `done`.
	 * Mismatch → `error('output_mismatch')`. Prefer the registry's
	 * `outputSchema` (per-workflow); this dep is the fallback for hosts
	 * that wire `workflowFn` directly.
	 */
	outputSchema?: SchemaLike<unknown>
	describeStep?: DescribeStepFn
	/**
	 * Pre-fixed answers for `ask-human` opens (specs §5, `-y`): when the
	 * tool is `ask-human` and a pre-fixed answer exists for the label,
	 * the open commits a `resolved` row (consuming the idx like any
	 * open) and publishes no stream event — replay hits it normally.
	 * Keyed by `label` (the stable debug key).
	 */
	prefixedAnswers?: Record<string, unknown>
	/**
	 * Stream sink (specs §3.5, checklist 5.2): receives
	 * `interaction_opened` per committed open + `run_status` on every
	 * tick end. The driver never throws on sink failure (best-effort).
	 */
	onEvent?: (event: WorkflowStreamEvent) => void
	/**
	 * Budget + timeout overrides (specs §7; checklist 2.5/6.1).
	 * Defaults: `maxOpens` 50, `maxBytes` 5MB, `maxWallMs` 24h,
	 * `tickMaxMs` 30s. Tests inject small values.
	 */
	maxOpens?: number
	maxBytes?: number
	maxWallMs?: number
	tickMaxMs?: number
	/** Tick start for `maxWallMs` (defaults to the run's `created_at`). */
	now?: () => number
	/**
	 * Production HEAD URL for staleness detection (specs §8, R7): the
	 * host passes `VERCEL_PROJECT_PRODUCTION_URL` (or its cached
	 * equivalent). When set and different from the run's
	 * `deployment_url`, the tick emits a durable `version_stale` event
	 * but the run continues. Absent = no staleness signal.
	 */
	prodDeploymentUrl?: string
	/**
	 * Persist a durable stream event (specs §3.5 `version_stale`). The
	 * driver emits best-effort via `onEvent`; the host transport makes it
	 * durable (workflow stream table / SSE replay). Absent = `onEvent`
	 * only.
	 */
	persistEvent?: (event: WorkflowStreamEvent) => Promise<void> | void
}

export interface TickResult {
	status: 'done' | 'waiting' | 'error' | 'cancelled'
	returnValue?: unknown
	error?: string
	opened: { idx: number; kind: InteractionKind; label: string }[]
}

/** Collect per §3.6: any `StepError` beats `Suspend` beats success. */
export function collectOutcome(outcomes: Map<number, CallOutcome>): {
	stepError?: { code: string; idx?: number }
	suspended?: { idx: number }
} {
	let suspended: { idx: number } | undefined
	for (const o of outcomes.values()) {
		if (o.kind === 'step-error') return { stepError: { code: o.code, idx: o.idx } }
		if (o.kind === 'suspend' && !suspended) suspended = { idx: o.idx }
	}
	return suspended ? { suspended } : {}
}

/** `true` when any recorded outcome is control-flow (R0 guard input). */
export function hasControlFlowOutcome(outcomes: Map<number, CallOutcome>): boolean {
	for (const o of outcomes.values()) {
		if (o.kind === 'suspend' || o.kind === 'step-error') return true
	}
	return false
}

function stepError(code: string, idx?: number): never {
	throwControlFlow({ kind: 'step-error', code, idx })
}

function suspend(idx: number): never {
	throwControlFlow({ kind: 'suspend', code: 'suspended', idx })
}

/** `error('budget_exceeded:<which>')` sentinel (specs §7). */
function budgetExceeded(which: 'maxOpens' | 'maxBytes' | 'maxWallMs', idx?: number): never {
	stepError(`budget_exceeded:${which}`, idx)
}

/**
 * Byte size of a journal payload for `maxBytes` (specs §7: sum of
 * `input_json` + `output_json`, memo rows included). `JSON.stringify`
 * length is the persisted encoding, so it matches the DB cost.
 */
/**
 * Normalize a deployment URL to its bare host for staleness comparison
 * (7.3): strips scheme, trailing slash and lowercases. `VERCEL_URL` is a
 * bare host (`x.vercel.app`), `VERCEL_PROJECT_PRODUCTION_URL` may be a
 * bare host or a full URL — raw string comparison false-positives.
 */
export function normalizeDeploymentUrl(url: string): string {
	return url.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/\/$/, '').toLowerCase()
}

export function journalBytes(value: unknown): number {
	try {
		return JSON.stringify(value ?? {}).length
	} catch {
		return 0
	}
}

/**
 * Pre-open budget gate (specs §7): `maxOpens` counts interaction opens
 * committed or in-flight this tick (`state.pendingOpens`), `maxBytes`
 * seeds from the persisted `bytes_used` column (bumped by the journal on
 * every open/resolve/memo write, so prior-tick output + memo bytes count)
 * plus this tick's fresh input and queued memo writes, `maxWallMs`
 * measures from the run's `created_at`. Exceed → terminal
 * `budget_exceeded:<which>`, no new row committed.
 */
function checkOpenBudgets(state: TickState, inputJson: unknown, idx: number): void {
	if (state.now() - state.runStartedAt > state.maxWallMs) {
		state.outcomes.set(idx, { kind: 'step-error', code: 'budget_exceeded:maxWallMs', idx })
		budgetExceeded('maxWallMs', idx)
	}
	// `maxOpens` counts opens COMMITTED or in-flight this tick
	// (`pendingOpens`), not journal rows (replay hits must never trip
	// it — a tick replaying 50 resolved rows opens nothing new). The
	// CURRENT open reserves its slot FIRST: two opens racing in one
	// sync block (`wf.all([t1, t2])` with `maxOpens: 1`) must fail the
	// second even though neither has committed yet. Reservation is
	// synchronous at gate time (before the first await) so the race is
	// deterministic.
	state.pendingOpens.push({ idx, kind: '__reserve__', label: '__reserve__' })
	if (state.pendingOpens.length > state.maxOpens) {
		state.outcomes.set(idx, { kind: 'step-error', code: 'budget_exceeded:maxOpens', idx })
		budgetExceeded('maxOpens', idx)
	}
	// Seed from the persisted column (prior ticks' inputs, resolved
	// outputs and memo bytes are already in there via the journal
	// bumps) — never re-scan `state.journal` (replay hits must not pay
	// for history). `state.memos` needs no separate term either: queued
	// writes are in `memoWrites`, persisted ones in `baseBytes`.
	let bytes = state.baseBytes + journalBytes(inputJson)
	for (const w of state.memoWrites) bytes += journalBytes(w.output)
	if (bytes > state.maxBytes) {
		state.outcomes.set(idx, { kind: 'step-error', code: 'budget_exceeded:maxBytes', idx })
		budgetExceeded('maxBytes', idx)
	}
}

function assertNoPromise(value: unknown, idx?: number, depth = 0): void {
	if (
		value instanceof Promise ||
		(value !== null &&
			typeof value === 'object' &&
			typeof (value as { then?: unknown }).then === 'function')
	) {
		stepError('promise_arg', idx)
	}
	// Bounded deep check (§2 rule 1): `{ q: somePromise }` would
	// otherwise `JSON.stringify` to `{}` — silent wrong-tool-input now,
	// `NonDeterminism` later. Depth 3 covers realistic payloads; deeper
	// structures are vanishingly rare as tool args.
	if (depth < 3 && value !== null && typeof value === 'object') {
		if (Array.isArray(value)) {
			for (const v of value) assertNoPromise(v, idx, depth + 1)
		} else {
			for (const v of Object.values(value)) assertNoPromise(v, idx, depth + 1)
		}
	}
}

/** `assertSameCall`: kind + label + payload hash, never full bytes (specs §3.3). */
function assertSameCall(
	state: TickState,
	rec: WorkflowInteractionRow,
	kind: InteractionKind,
	label: string,
	tool: string | null,
	inputJson: unknown
): void {
	if (rec.kind !== kind || rec.label !== label || (rec.tool ?? null) !== (tool ?? null)) {
		state.outcomes.set(rec.idx, { kind: 'step-error', code: 'NonDeterminism', idx: rec.idx })
		stepError('NonDeterminism', rec.idx)
	}
	const stored = payloadHash(rec.input_json ?? {})
	if (stored !== payloadHash(inputJson ?? {})) {
		state.outcomes.set(rec.idx, { kind: 'step-error', code: 'NonDeterminism', idx: rec.idx })
		stepError('NonDeterminism', rec.idx)
	}
}

/**
 * Core call-site routine (specs §3.3 `async call`): replay-hit returns the
 * stored output (plain value — `await` continues on a microtask); journal
 * miss/mismatch → `StepError`; `resolved` → value; `failed` →
 * `InteractionFailed`; `open` → record + `Suspend`.
 *
 * Split into a SYNC prefix (replay check + semaphore-safe, runs at the
 * call site before the caller can open a second site) and the async
 * record path. Callers that need sync-at-call-site semantics (the
 * `Session.prompt` semaphore, B2) must invoke `callSiteSync` first.
 */
function callSiteSync(
	state: TickState,
	kind: InteractionKind,
	label: string,
	inputJson: unknown,
	opts: { tool?: string | null; sessionId?: string | null } = {}
):
	| { hit: true; row: WorkflowInteractionRow; idx: number }
	| { hit: false; idx: number; tool: string | null } {
	const idx = state.counter++
	const tool = opts.tool ?? null
	if (idx < state.nextIndex) {
		const rec = state.journal.get(idx)
		if (!rec) {
			state.outcomes.set(idx, { kind: 'step-error', code: 'NonDeterminism', idx })
			stepError('NonDeterminism', idx)
		}
		assertSameCall(state, rec as WorkflowInteractionRow, kind, label, tool, inputJson)
		return { hit: true, row: rec as WorkflowInteractionRow, idx }
	}
	return { hit: false, idx, tool }
}

function callSite(
	state: TickState,
	kind: InteractionKind,
	label: string,
	inputJson: unknown,
	opts: { tool?: string | null; sessionId?: string | null; toolsetJson?: unknown } = {}
): Promise<unknown> {
	// NON-async on purpose: `return p` from an `async` wrapper would
	// create a SECOND promise adopting the first, and a no-op guard on
	// the inner would not mark the outer handled. One promise object
	// per handle → one guard covers every floater.
	// `assertNoPromise` runs here (not inside the async tail) so a
	// promise-valued input throws synchronously at the call site —
	// before any promise object exists to guard.
	assertNoPromise(inputJson)
	const pre = callSiteSync(state, kind, label, inputJson, opts)
	const p = callSiteAsync(state, pre, kind, label, inputJson, opts)
	// Self-guard at creation (§1 floater fix): a tool handle created
	// before a `need_memo` throw may never be awaited (memo-warm probe
	// abort). The no-op branch marks the rejection handled for Node;
	// real awaiters still observe it.
	p.then(
		() => {},
		() => {}
	)
	return p
}

async function callSiteAsync(
	state: TickState,
	pre:
		| { hit: true; row: WorkflowInteractionRow; idx: number }
		| { hit: false; idx: number; tool: string | null },
	kind: InteractionKind,
	label: string,
	inputJson: unknown,
	opts: { tool?: string | null; sessionId?: string | null; toolsetJson?: unknown } = {}
): Promise<unknown> {
	if (pre.hit) {
		const row = pre.row
		const idx = pre.idx
		if (row.status === 'resolved') {
			state.outcomes.set(idx, { kind: 'value', value: row.output_json })
			return row.output_json
		}
		if (row.status === 'failed') {
			const err = new InteractionFailed(row.error || 'interaction failed', {
				idx,
				kind,
				label,
			})
			state.outcomes.set(idx, { kind: 'failed', error: err })
			throw err
		}
		state.outcomes.set(idx, { kind: 'suspend', idx })
		suspend(idx)
	}
	const { idx, tool } = pre
	// Budget gate BEFORE describeStep/open (specs §7): exceed → terminal
	// `budget_exceeded:<which>`, no new row committed. Runs inside the
	// async tail (not the sync prefix): the gate throws a StepError
	// sentinel, and a sync throw here would escape `callSite` before the
	// guarding promise exists — an uncatchable sync throw instead of a
	// collectible tick outcome.
	checkOpenBudgets(state, inputJson, idx)
	// Record path: describeStep BEFORE the open TX (R3).
	let labelText: string
	try {
		labelText = state.describeStep({
			label,
			kind,
			tool: tool ?? undefined,
			inputSummary: summarizeInput(inputJson),
		})
	} catch {
		state.outcomes.set(idx, { kind: 'step-error', code: 'describeStep_throw', idx })
		stepError('describeStep_throw', idx)
	}
	await openInteraction(
		state.runId,
		idx,
		{
			kind,
			label,
			label_text: labelText as string,
			tool,
			inputJson,
			sessionId: opts.sessionId ?? null,
			toolsetJson: opts.toolsetJson,
		},
		state.sql
	)
	state.nextIndex = idx + 1
	// Replace this open's `__reserve__` slot with the real entry (the
	// gate pushed a placeholder synchronously so racing opens in one
	// sync block serialize deterministically).
	const slot = state.pendingOpens.findIndex((o) => o.idx === idx && o.kind === '__reserve__')
	if (slot >= 0) state.pendingOpens[slot] = { idx, kind, label }
	else state.pendingOpens.push({ idx, kind, label })
	// Pre-fixed `ask-human` (specs §5, `-y`): resolve immediately at
	// open time — consuming the idx like any open — but publish NO
	// stream event (replay hits the row normally). Resolving "without a
	// visible row" would bump `nextIndex` with no row → guaranteed
	// `NonDeterminism` on the next tick. Pre-fixed rows stay invisible
	// on the stream (A3 — the FE never shows a spinner for an answered
	// question), so the `interaction_opened` emit happens below, after
	// this branch.
	if (kind === 'tool' && tool === 'ask-human' && label in state.prefixedAnswers) {
		const output = state.prefixedAnswers[label]
		await resolveInteraction(state.runId, idx, { status: 'resolved', output }, state.sql)
		state.outcomes.set(idx, { kind: 'value', value: output })
		return output
	}
	emitEvent(state, {
		type: 'interaction_opened',
		idx,
		kind,
		tool: tool ?? undefined,
		label,
		label_text: labelText as string,
	})
	// Workflow-tool scheduling (specs §5, checklist 4.2): the tick that
	// opens a workflow-tool row enqueues its `execute` via the injected
	// `runTool` — it does NOT run inline. `runTool` resolves the journal
	// row (host writes `resolved` + `output_json`); the following tick
	// replays past it. Fire-and-forget here: the open suspends this tick
	// regardless; a `runTool` throw is recorded but never fails the tick
	// (the row stays `open` → `waiting`, the tool retry resolves it).
	// Skipped when the host didn't wire `runTool` (unit tests inject
	// only `sql` + `workflowFn`): the row still opens + suspends, and
	// the test resolves it by hand.
	if (kind === 'tool' && tool !== 'ask-human' && depsWiredRunTool(state)) {
		const run = state.runTool(tool as string, inputJson).then(
			() => {},
			(err: unknown) => {
				state.logLines.push({
					label,
					idx,
					message: `tool enqueue failed: ${err instanceof Error ? err.message : String(err)}`,
				})
			}
		)
		// Await the enqueue (not the tool): backpressure so a fan-out of
		// N opens enqueues N executes before suspending. The tool itself
		// resolves asynchronously via the journal.
		await run
	}
	state.outcomes.set(idx, { kind: 'suspend', idx })
	suspend(idx)
}

/** Best-effort stream emit: the driver never throws on sink failure. */
function emitEvent(state: TickState, event: WorkflowStreamEvent): void {
	try {
		state.onEvent?.(event)
	} catch {
		// Best-effort: a broken sink must not fail the tick.
	}
}

/** Default `runTool` sentinel: throws so unwired hosts fail fast. */
function unwiredRunTool(): Promise<void> {
	throw new Error('runTool not wired (Phase 4.2)')
}

/**
 * Whether the host wired a real `runTool` (checklist 4.2). Identity
 * comparison against the default — no probing, no side effects. Unit
 * tests that inject only `sql` + `workflowFn` still open + suspend
 * (resolving rows by hand); wired hosts get the enqueue path.
 */
function depsWiredRunTool(state: TickState): boolean {
	return state.runTool !== unwiredRunTool
}

/**
 * Tick-scoped memo read (§2.3): one DB read per key per tick; later
 * `once` calls with the same key hit `state.memos`.
 */
async function readMemoCached(state: TickState, key: string): Promise<WorkflowMemoRow | null> {
	const hit = state.memos.get(key)
	if (hit !== undefined) return hit
	const row = await readMemo(state.runId, key, state.sql)
	state.memos.set(key, row)
	return row
}

/** Queue a memo write-back (flushed before the tick persists). */
function queueMemoWrite(state: TickState, key: string, fnHash: string, output: unknown): void {
	if (!state.memoWrites.some((w) => w.key === key)) {
		state.memoWrites.push({ key, fnHash, output })
	}
	state.memos.set(key, {
		run_id: state.runId,
		key,
		fn_hash: fnHash,
		output_json: output,
		created_at: '',
	})
}

/** Flush queued memo writes (first-write-wins at the DB). */
async function flushMemoWrites(state: TickState): Promise<void> {
	for (const w of state.memoWrites) {
		await writeMemo(state.runId, w.key, w.fnHash, w.output, state.sql)
	}
	state.memoWrites = []
}

/**
 * Flush `wf.log` lines + auto interaction-opened lines (§3.4). Only
 * ticks that persist NEW state (open / resolve / done / error) call
 * this — replay-only ticks emit nothing, so budgets count persisted
 * lines only (§7).
 */
async function flushLogLines(state: TickState, tick: number): Promise<void> {
	// `committedOpens`: never persist `__reserve__` budget slots
	// (in-flight opens that never committed — e.g. the over-budget
	// handle in a failed `wf.all` batch).
	const lines = [
		...committedOpens(state).map((o) => ({
			label: o.label,
			idx: o.idx,
			message: `opened ${o.kind} ${o.label}`,
		})),
		...state.logLines,
	]
	if (!lines.length) return
	await appendLogbook(state.runId, tick, lines, state.sql)
	state.logLines = []
}

/**
 * Sync `wf.once` core (§2.3): the tick pre-loads `state.memos` lazily on
 * first use — but `WFContext.once` is sync, so the DB read must have
 * happened already. Resolution: `tick()` warms the missed key on a
 * `need_memo` sentinel and re-executes (bounded: one re-execution per
 * distinct key). Pure code re-runs identically, so re-execution is safe.
 */
function onceSync<T>(state: TickState, key: string, fn: () => T): T {
	const hash = fnSourceHash(fn as (...args: never[]) => unknown)
	const hit = state.memos.get(key)
	if (hit !== undefined) {
		if (hit === null) {
			const value = fn()
			if (value instanceof Promise) throw new Error('wf.once fn must be sync')
			queueMemoWrite(state, key, hash, value)
			return value
		}
		if (hit.fn_hash !== hash) {
			state.outcomes.set(state.counter, {
				kind: 'step-error',
				code: 'once_hash_mismatch',
				idx: state.counter,
			})
			stepError('once_hash_mismatch', state.counter)
		}
		return hit.output_json as T
	}
	// Keyed miss (`need_memo:<key>`): the warm loop extracts the key from
	// the code. Keying matters for `wf.now()` — it bypasses
	// `WFContext.once`, so an unkeyed miss could never be warmed and the
	// tick would spin 64× into `too many memo misses`.
	throwControlFlow({ kind: 'suspend', code: `need_memo:${key}`, idx: state.counter })
}

/**
 * Warm the single memo key missed by the last execution: re-run the
 * workflow function with a recording `once` that captures the missed key.
 * The probe aborts at the first unwarmed `once` (fresh interaction opens
 * would re-throw `Suspend` — also a clean abort). Before the real pass
 * re-executes, `state.journal` is refreshed (re-`listInteractions`) so
 * rows INSERTed by the aborted attempt are visible — otherwise the
 * re-execution would report a `NonDeterminism` journal-miss on idxs it
 * legitimately opened. Combined with idempotent `openInteraction`
 * (`ON CONFLICT DO NOTHING`), in-flight fan-out INSERTs from the aborted
 * attempt can neither duplicate nor vanish.
 */
async function warmNextMemo(
	state: TickState,
	wf: WFContext<ToolRegistry>,
	input: unknown,
	fn: (wf: WFContext<ToolRegistry>, input: unknown) => Promise<unknown>
): Promise<void> {
	// Floaters: the probe runs real user code, so fan-out handles created
	// BEFORE the missed `once` (e.g. `const h=[t1,t2]; wf.once('k',…)`)
	// are already in-flight when the probe aborts — nobody ever awaits
	// them. Every handle self-guards at creation (`callSite` attaches a
	// no-op reject branch to the single promise object it returns), so
	// Node never reports them; here the probe only needs to SETTLE them
	// before the journal refresh below, so in-flight INSERTs commit
	// before re-execution replays them. Handles are tracked explicitly:
	// the journal can't serve as the registry (rows land there only
	// AFTER the INSERT commits — exactly what we're waiting for).
	// NOTE: the probe `use` trap must return the `callSite` promise
	// DIRECTLY (no `async` wrapper, no `.then` chain): any wrapper
	// creates a second promise object the self-guard doesn't cover.
	const floaters: Promise<unknown>[] = []
	const track = <T>(p: Promise<T>): Promise<T> => {
		floaters.push(p as Promise<unknown>)
		return p
	}
	const wrapSession = (s: Session): Session =>
		({
			...s,
			prompt: (label: string, text: string, opts?: BasePromptOpts) =>
				track((s as Session).prompt(label, text, opts as never)),
		}) as Session
	const probeUse = new Proxy(
		{},
		{
			get(_t, tool: string) {
				const fn = (input: unknown, opts?: { label?: string }) =>
					track(
						(wf.use as unknown as Record<string, (i: unknown, o?: unknown) => Promise<unknown>>)[
							tool
						](input, opts)
					)
				Object.defineProperty(fn, 'tool', { value: tool })
				return fn
			},
		}
	) as WFContext<ToolRegistry>['use']
	const probe = {
		...wf,
		use: probeUse,
		async createSession(i: WFCreateSessionInput) {
			return wrapSession(await track(wf.createSession(i)))
		},
		now(): number {
			// `wf.now()` bypasses `WFContext.once` (it calls `onceSync`
			// directly), so route it through the keyed probe `once` —
			// otherwise its miss could never be warmed and the tick
			// would spin into `too many memo misses`.
			return probe.once('now', () => Date.now())
		},
		once<T>(key: string, _fn: () => T): T {
			if (!state.memos.has(key)) {
				throwControlFlow({ kind: 'suspend', code: `need_memo:${key}`, idx: state.counter })
			}
			return wf.once(key, _fn)
		},
	} as WFContext<ToolRegistry>
	state.counter = 0
	try {
		await fn(probe, input)
	} catch (e) {
		if (isControlFlow(e)) {
			const code = (e as ControlFlowSentinel).code
			if (code.startsWith('need_memo:')) {
				const key = code.slice('need_memo:'.length)
				await readMemoCached(state, key)
			}
			// Suspend / step-error / need_memo (warmed meanwhile): stop.
			// NOTE: no counter/outcomes/opens reset here — the real pass
			// resets its own in `runWithMemos`. Resetting here would wipe
			// the semaphore StepError the probe just recorded.
		} else {
			throw e
		}
	} finally {
		// Settle floaters first: their INSERTs must commit before the
		// refresh, otherwise re-execution re-opens instead of replaying.
		// (Handles are already marked handled by the `callSite`
		// self-guard, so settling here is rejection-safe.)
		await Promise.allSettled(floaters)
		// Refresh the journal: the aborted attempt may have committed
		// opens the re-execution must replay-hit, not re-open.
		const fresh = await listInteractions(state.runId, state.sql)
		state.journal = new Map(fresh.map((r) => [r.idx, r]))
		for (const r of fresh) {
			if (r.idx + 1 > state.nextIndex) state.nextIndex = r.idx + 1
		}
	}
}

/**
 * Prompt input for journal identity: schema presence PLUS a schema
 * identity hash, not just `!!opts`. A swapped schema (same presence,
 * different shape) must be `NonDeterminism`, never silent reuse of the
 * old output — replay still re-validates the stored value against the
 * current schema, but identity catches the swap first.
 */
function promptIdentityOpts(opts?: { expectedSchema?: unknown }): {
	hasSchema: boolean
	schemaHash?: string
} {
	const schema = opts?.expectedSchema
	if (schema === undefined) return { hasSchema: false }
	return { hasSchema: true, schemaHash: schemaIdentity(schema) }
}

/**
 * Identity hash of an `expectedSchema`: constructor name + canonical
 * structure + `safeParse` source. Structure alone collides on
 * hand-rolled `{ safeParse }` literals (functions are dropped by
 * `stableStringify`); source alone collides on same-class schemas
 * (e.g. two zod objects share `safeParse`). Circular schemas fall back
 * to `'unhashable'` — identity degrades to presence + re-validation.
 */
function schemaIdentity(schema: unknown): string {
	const ctor = (schema as { constructor?: { name?: unknown } })?.constructor?.name ?? ''
	let def: string
	try {
		def = stableStringify(schema)
	} catch {
		def = 'unhashable'
	}
	const safeParse = (schema as { safeParse?: unknown })?.safeParse
	const fnSrc =
		typeof safeParse === 'function' ? fnSourceHash(safeParse as (...args: never[]) => unknown) : ''
	return payloadHash({
		ctor: typeof ctor === 'string' ? ctor : '',
		def,
		fnSrc,
	})
}

/**
 * Truncated display input for `describeStep` (specs §2.1: "titles,
 * counts — never blobs"). Small inputs pass through as-is; large ones
 * become a truncated string so a blob-embedding `describeStep` can't
 * bloat the persisted `label_text`.
 */
function summarizeInput(value: unknown): unknown {
	let s: string
	try {
		s = JSON.stringify(value ?? null) ?? 'null'
	} catch {
		return '[unserializable input]'
	}
	return s.length > 500 ? `${s.slice(0, 500)}… (truncated)` : value
}

/**
 * Validate a resolved prompt answer against its `expectedSchema`
 * (specs §2.2, checklist 4.4). No schema → the raw string passes
 * through. With a schema → the §2.2 ladder extracts + validates; the
 * journal stores the STRUCTURED value (`output_json`), so replay hits
 * return typed data without re-validating.
 */
function validatePromptAnswer<T>(
	raw: unknown,
	opts: { expectedSchema?: unknown } | undefined,
	site: { idx: number; kind: string; label: string }
): T {
	const schema = opts?.expectedSchema as
		| { safeParse(d: unknown): { success: boolean; data?: T } }
		| undefined
	if (!schema) return raw as T
	return validateStructuredAnswer<T>(raw, schema, site)
}

/** Per-tick `Session` object: semaphore owned by the receiver (B2). */
function makeSession(state: TickState, sessionId: string, _toolsetJson?: unknown): Session {
	let liveCount = 0
	const session = {
		id: sessionId,
		prompt(label: string, text: string, opts?: { expectedSchema?: unknown }): Promise<never> {
			// Sync-at-call-site semaphore (B2): `callSiteSync` runs the
			// replay check + consumes the idx NOW, in the caller's sync
			// block — so the second `prompt()` in one `wf.all([...])`
			// array sees `liveCount > 0` before either body awaits.
			// NOTE: must stay NON-async (explicit `Promise` return): an
			// `async` body defers everything past the sync block.
			// Divergence note (§4): the check counts "calls in one sync
			// block", not "live generations" — two already-resolved
			// prompts in one block also trip it. Unreachable from
			// successful history (tick 1 could never have resolved both),
			// so kept strict for v1.
			const pre = callSiteSync(state, 'prompt', label, {
				sessionId,
				text,
				opts: promptIdentityOpts(opts),
			})
			liveCount++
			if (liveCount > 1) {
				state.outcomes.set(pre.idx, {
					kind: 'step-error',
					code: 'session_double_prompt',
					idx: pre.idx,
				})
				liveCount--
				stepError('session_double_prompt', pre.idx)
			}
			assertNoPromise(text)
			const p = finishPromptCallSite(
				state,
				pre,
				label,
				{
					sessionId,
					text,
					opts: promptIdentityOpts(opts),
				},
				opts
			).then(
				(v) => {
					liveCount--
					return v as never
				},
				(e) => {
					liveCount--
					throw e
				}
			)
			// Self-guard at creation (§1 floater fix): a prompt handle
			// created before a `need_memo` throw may never be awaited
			// (memo-warm probe abort). The no-op branch marks the
			// rejection handled for Node; real awaiters still observe it.
			p.then(
				() => {},
				() => {}
			)
			return p
		},
	}
	return session as unknown as Session
}

/** Async tail of a prompt call site after the sync prefix ran. */
async function finishPromptCallSite(
	state: TickState,
	pre:
		| { hit: true; row: WorkflowInteractionRow; idx: number }
		| { hit: false; idx: number; tool: string | null },
	label: string,
	inputJson: unknown,
	promptOpts?: { expectedSchema?: unknown }
): Promise<unknown> {
	if (pre.hit) {
		const row = pre.row
		const idx = pre.idx
		if (row.status === 'resolved') {
			// Structured rows (4.4) re-validate the stored value against
			// the CURRENT schema on every replay (deterministic): a
			// swapped schema surfaces as `InteractionFailed` here even
			// when the identity hash collides.
			const value = validatePromptAnswer(row.output_json, promptOpts, {
				idx,
				kind: 'prompt',
				label,
			})
			state.outcomes.set(idx, { kind: 'value', value })
			return value
		}
		if (row.status === 'failed') {
			const err = new InteractionFailed(row.error || 'interaction failed', {
				idx,
				kind: 'prompt',
				label,
			})
			state.outcomes.set(idx, { kind: 'failed', error: err })
			throw err
		}
		state.outcomes.set(idx, { kind: 'suspend', idx })
		suspend(idx)
	}
	const { idx, tool } = pre
	checkOpenBudgets(state, inputJson, idx)
	let labelText: string
	try {
		labelText = state.describeStep({
			label,
			kind: 'prompt',
			tool: tool ?? undefined,
			inputSummary: summarizeInput(inputJson),
		})
	} catch {
		state.outcomes.set(idx, { kind: 'step-error', code: 'describeStep_throw', idx })
		stepError('describeStep_throw', idx)
	}
	await openInteraction(
		state.runId,
		idx,
		{
			kind: 'prompt',
			label,
			label_text: labelText as string,
			tool,
			inputJson,
			sessionId: (inputJson as { sessionId?: string }).sessionId ?? null,
		},
		state.sql
	)
	state.nextIndex = idx + 1
	const slot = state.pendingOpens.findIndex((o) => o.idx === idx && o.kind === '__reserve__')
	if (slot >= 0) state.pendingOpens[slot] = { idx, kind: 'prompt', label }
	else state.pendingOpens.push({ idx, kind: 'prompt', label })
	// R4: one `interaction_opened` per committed open — prompts included
	// (the FE renders progress from `label_text` alone).
	emitEvent(state, {
		type: 'interaction_opened',
		idx,
		kind: 'prompt',
		label,
		label_text: labelText as string,
	})
	state.outcomes.set(idx, { kind: 'suspend', idx })
	suspend(idx)
}

function buildContext(state: TickState): WFContext<ToolRegistry> {
	const use = new Proxy(
		{},
		{
			get(_t, tool: string) {
				const fn = (input: unknown, opts?: { label?: string }) =>
					callSite(state, 'tool', opts?.label ?? tool, input, { tool })
				Object.defineProperty(fn, 'tool', { value: tool })
				return fn
			},
		}
	) as WFContext<ToolRegistry>['use']

	return {
		runId: state.runId,
		use,
		async createSession(input: WFCreateSessionInput) {
			assertNoPromise(input)
			// Reserve synchronously like every other call site: two
			// `createSession` calls in one sync block
			// (`wf.all([create(), create()])`) must get distinct idxs.
			// The counter is consumed NOW, before the first await.
			const idx = state.counter++
			if (idx < state.nextIndex) {
				const rec = state.journal.get(idx)
				if (!rec) {
					state.outcomes.set(idx, { kind: 'step-error', code: 'NonDeterminism', idx })
					stepError('NonDeterminism', idx)
				}
				const row = rec as WorkflowInteractionRow
				if (row.kind !== 'session') {
					state.outcomes.set(idx, { kind: 'step-error', code: 'NonDeterminism', idx })
					stepError('NonDeterminism', idx)
				}
				if (row.status === 'failed') {
					const err = new InteractionFailed(row.error || 'session_create_failed', {
						idx,
						kind: 'session',
						label: row.label,
					})
					state.outcomes.set(idx, { kind: 'failed', error: err })
					throw err
				}
				if (row.status === 'resolved' || row.status === 'open') {
					// R1 replays (and in-flight rows after a crash) return the
					// stored id without I/O. `open` with a session id means
					// the POST succeeded but the tick crashed before suspend
					// collection — safe to reuse.
					if (!row.session_id) {
						state.outcomes.set(idx, { kind: 'suspend', idx })
						suspend(idx)
					}
					// Identity: a changed model/system/toolset must not
					// silently reuse the stored session.
					assertSameCall(state, row, 'session', 'session', null, input)
					state.outcomes.set(idx, { kind: 'value', value: row.session_id })
					return makeSession(state, row.session_id as string, row.toolset_json)
				}
				state.outcomes.set(idx, { kind: 'suspend', idx })
				suspend(idx)
			}
			// Fresh open: budget gate, then describeStep before TX (R3),
			// then INSERT + bump.
			checkOpenBudgets(state, input, idx)
			let labelText = 'Creating session…'
			try {
				labelText = state.describeStep({ label: 'session', kind: 'session' })
			} catch {
				state.outcomes.set(idx, { kind: 'step-error', code: 'describeStep_throw', idx })
				stepError('describeStep_throw', idx)
			}
			await openInteraction(
				state.runId,
				idx,
				{ kind: 'session', label: 'session', label_text: labelText, inputJson: input },
				state.sql
			)
			state.nextIndex = idx + 1
			const slot = state.pendingOpens.findIndex((o) => o.idx === idx && o.kind === '__reserve__')
			if (slot >= 0) state.pendingOpens[slot] = { idx, kind: 'session', label: 'session' }
			else state.pendingOpens.push({ idx, kind: 'session', label: 'session' })
			// R1: the POST can fail AFTER the row commits — mark `failed` +
			// StepError (terminal, never a wait).
			let sessionId: string
			try {
				sessionId = await state.postSession(input)
			} catch (e) {
				await state.sql`
					UPDATE workflow_interactions
					SET status = 'failed', error = ${e instanceof Error ? e.message : String(e)}, updated_at = NOW()
					WHERE run_id = ${state.runId} AND idx = ${idx}`
				state.outcomes.set(idx, { kind: 'step-error', code: 'session_create_failed', idx })
				stepError('session_create_failed', idx)
			}
			// The session row is a live generation handle, not a one-shot
			// call: it stays `open` (with `session_id` written back) for
			// the run's lifetime. `open` + session id replays as a hit
			// (see above); expiry/waiting derivation counts only
			// prompt/tool rows. Documented here instead of resolved per
			// R5: resolving it would break the crash-after-POST reuse.
			await state.sql`
				UPDATE workflow_interactions
				SET session_id = ${sessionId as string}, updated_at = NOW()
				WHERE run_id = ${state.runId} AND idx = ${idx}`
			// R4: the session row committed above — one `interaction_opened`.
			emitEvent(state, {
				type: 'interaction_opened',
				idx,
				kind: 'session',
				label: 'session',
				label_text: labelText as string,
			})
			state.outcomes.set(idx, { kind: 'suspend', idx })
			suspend(idx)
		},
		async all<T>(handles: Promise<T>[]): Promise<T[]> {
			// Fail-fast + sentinel precedence via context collection (§3.6):
			// settle everything, then: StepError first (a semaphore or
			// budget StepError recorded at open time beats the Suspend
			// sentinel the first handle rejects with — `Promise.all`
			// order is NOT trusted), then the first InteractionFailed
			// (fail-fast: a `[failed@0, open@1]` mix must surface the
			// failure, never wait forever on the open), then the first
			// sentinel so the tick ends as `waiting` through the normal
			// control-flow path. Bare `Promise.all` stays order-dependent
			// — prefer `wf.all`.
			const settled = await Promise.allSettled(handles)
			const collected = collectOutcome(state.outcomes)
			if (collected.stepError) stepError(collected.stepError.code, collected.stepError.idx)
			for (const s of settled) {
				if (s.status === 'rejected' && s.reason instanceof InteractionFailed) {
					throw s.reason
				}
			}
			// A rejected handle carrying a StepError sentinel (budget or
			// semaphore gate) beats Suspend even when the gate recorded
			// nothing in `state.outcomes` (e.g. the gate threw before the
			// record path ran). Scan the batch before falling back to the
			// first sentinel.
			for (const s of settled) {
				if (
					s.status === 'rejected' &&
					isControlFlow(s.reason) &&
					(s.reason as ControlFlowSentinel).kind === 'step-error'
				) {
					throw s.reason
				}
			}
			for (const s of settled) {
				if (s.status === 'rejected' && isControlFlow(s.reason)) throw s.reason
			}
			for (const s of settled) {
				if (s.status === 'rejected') throw s.reason
			}
			if (collected.suspended) suspend(collected.suspended.idx)
			return settled.map((s) => (s as PromiseFulfilledResult<T>).value)
		},
		once<T>(key: string, fn: () => T): T {
			// Journaled value (§2.3): first tick runs `fn`, persists
			// `{ key, fnSourceHash, output_json }`, returns the value;
			// replay returns cached `output_json` without calling `fn`.
			// Hash mismatch → StepError, never silent recompute. Never
			// consumes an interaction `idx` (separate memo namespace).
			// Sync facade over the tick-scoped cache (`state.memos`,
			// warmed via the `need_memo` loop in `tick()`).
			// `Date.now()`/`Math.random()` allowed ONLY inside `fn`.
			return onceSync(state, key, fn)
		},
		now(): number {
			return onceSync(state, 'now', () => Date.now())
		},
		parseJson<T>(raw: string, schema: SchemaLike<T>): T {
			// Workflow-side parse (specs §2.2): pure + deterministic, so
			// it runs inline (no idx). Import the ladder from the
			// client-safe barrel — same function the resolve path uses.
			return parseJson(raw, schema)
		},
		log(message: string, data?: unknown): void {
			state.logLines.push({ label: '', idx: null, message, data })
		},
	}
}

/**
 * Committed opens for `TickResult.opened`: strips `__reserve__` budget
 * slots (in-flight opens that never committed — e.g. the over-budget
 * handle in a failed `wf.all` batch).
 */
export function committedOpens(
	state: TickState
): { idx: number; kind: InteractionKind; label: string }[] {
	return state.pendingOpens.filter(
		(o): o is { idx: number; kind: InteractionKind; label: string } => o.kind !== '__reserve__'
	)
}

/**
 * Run one tick for `runId` (§3.1):
 * load → `resolveExpiries` → re-execute → `done` / `waiting` / `error`.
 */
export async function tick(runId: string, deps: TickDeps): Promise<TickResult> {
	const sql = deps.sql
	if (!sql) throw new Error('tick: deps.sql is required (host passes its Neon client)')
	const run = await getRun(runId, sql)
	if (!run) throw new Error(`workflow run not found: ${runId}`)
	if (run.status === 'done' || run.status === 'error' || run.status === 'cancelled') {
		// Distinct terminal: `cancelled` is NOT `error` (§3.5 run_status,
		// R5). Journal preserved for manual re-run.
		return {
			status: run.status,
			returnValue: run.return_json ?? undefined,
			error: run.error ?? undefined,
			opened: [],
		}
	}
	// Terminal runs short-circuit above: a `done` run returns its STORED
	// return value without re-executing (replay would re-run `once` fns
	// and hit hash drift on closures like `() => ++calls`).
	// Tick-start wall budget (specs §7): `maxWallMs` from the run's
	// `created_at` — a run older than the window fails without executing.
	const now = deps.now ?? Date.now
	const maxOpens = deps.maxOpens ?? 50
	const maxBytes = deps.maxBytes ?? 5 * 1024 * 1024
	const maxWallMs = deps.maxWallMs ?? 24 * 60 * 60 * 1000
	const tickMaxMs = deps.tickMaxMs ?? 30_000
	const runStartedAt = run.created_at ? Date.parse(run.created_at) : now()
	if (now() - runStartedAt > maxWallMs) {
		await sql`
			UPDATE workflow_runs
			SET status = 'error', error = ${`budget_exceeded:maxWallMs`}, updated_at = NOW()
			WHERE id = ${runId}`
		// `state` doesn't exist yet on this early path — emit best-effort directly.
		try {
			deps.onEvent?.({ type: 'run_status', status: 'error' })
		} catch {
			// Best-effort: a broken sink must not fail the tick.
		}
		return { status: 'error', error: 'budget_exceeded:maxWallMs', opened: [] }
	}
	await resolveExpiries(runId, sql)
	const journal = await listInteractions(runId, sql)
	const byIdx = new Map(journal.map((r) => [r.idx, r]))
	const state: TickState = {
		runId,
		journal: byIdx,
		nextIndex: run.next_index,
		counter: 0,
		outcomes: new Map(),
		describeStep: deps.describeStep ?? (({ label }) => label),
		sql,
		postSession:
			deps.postSession ??
			(() => {
				throw new Error('postSession not wired (Phase 4.2)')
			}),
		runTool: deps.runTool ?? unwiredRunTool,
		pendingOpens: [],
		logLines: [],
		memos: new Map(),
		memoWrites: [],
		maxOpens,
		maxBytes,
		maxWallMs,
		runStartedAt,
		// Seed for the `maxBytes` gate: prior ticks' inputs, resolved
		// outputs and memo bytes (the journal bumps this column on every
		// open/resolve/memo write). Neon returns BIGINT as number|string.
		baseBytes: Number((run as WorkflowRunRow).bytes_used ?? 0) || 0,
		now,
		prefixedAnswers: deps.prefixedAnswers ?? {},
		onEvent: deps.onEvent,
	}
	const wf = buildContext(state)
	// Phase 7: resolve the workflow function. Injected `workflowFn` wins
	// (tests); otherwise the run's `workflow_name@version` resolves
	// through the deploy-time registry (the starter imports the workflow
	// modules so the map is populated on this deployment — §8 pinning
	// means this IS the code that recorded the journal).
	let describeStepOverride: DescribeStepFn | undefined
	let outputSchema: SchemaLike<unknown> | undefined = deps.outputSchema
	let fn = deps.workflowFn
	if (!fn) {
		const lookup = deps.lookupWorkflow
		if (!lookup) throw new Error('tick: workflowFn or lookupWorkflow is required')
		const def = lookup(run.workflow_name, run.workflow_version)
		if (!def)
			throw new Error(`workflow not registered: ${run.workflow_name}@${run.workflow_version}`)
		fn = def.fn as (wf: WFContext<ToolRegistry>, input: unknown) => Promise<unknown>
		describeStepOverride = def.describeStep
		if (!outputSchema) outputSchema = def.outputSchema
	}
	if (describeStepOverride) state.describeStep = describeStepOverride
	const input = (run as WorkflowRunRow).input_json ?? {}

	// Phase 7.3 (R7): staleness is expected, not fatal. When the host
	// knows production HEAD and it differs from the run's pinned
	// deployment, emit a durable `version_stale` event — but continue.
	// Compared on normalized hosts: `VERCEL_URL` (bare host) and
	// `VERCEL_PROJECT_PRODUCTION_URL` (bare host or full URL) must not
	// false-positive on scheme/`https://` prefixes.
	const prodUrl = deps.prodDeploymentUrl
	if (prodUrl && run.deployment_url && normalizeDeploymentUrl(prodUrl) !== normalizeDeploymentUrl(run.deployment_url)) {
		const staleEvent: WorkflowStreamEvent = {
			type: 'version_stale',
			deployment_url: run.deployment_url,
			opened_at: run.created_at,
		}
		emitEvent(state, staleEvent)
		try {
			await deps.persistEvent?.(staleEvent)
		} catch {
			// Best-effort: a broken sink must not fail the tick.
		}
	}

	const failRun = async (error: string): Promise<TickResult> => {
		await flushMemoWrites(state)
		await flushLogLines(state, run.tick + 1)
		await sql`
			UPDATE workflow_runs
			SET status = 'error', error = ${error}, updated_at = NOW()
			WHERE id = ${runId}`
		return { status: 'error', error, opened: committedOpens(state) }
	}

	// `onceSync` memo loop: on a `need_memo` miss, warm the missed key
	// and re-execute (bounded by distinct keys: each pass warms ≥1 key).
	// Per-attempt state reset is scoped to the memo loop ONLY — the final
	// attempt's counter/outcomes/opens are the tick's outcome. (Resetting
	// unconditionally would wipe the suspend/step-error records the
	// `catch` below collects.)
	const runWithMemos = async (): Promise<unknown> => {
		for (let attempt = 0; attempt < 64; attempt++) {
			try {
				return await fn(wf, input)
			} catch (e) {
				const code = isControlFlow(e) ? (e as ControlFlowSentinel).code : ''
				if (code === 'need_memo' || code.startsWith('need_memo:')) {
					await warmNextMemo(state, wf, input, fn)
					if (attempt >= 63) throw new Error('too many memo misses')
					state.counter = 0
					state.outcomes = new Map()
					state.pendingOpens = []
					continue
				}
				throw e
			}
		}
		throw new Error('too many memo misses')
	}

	try {
		// In-tick guard (specs §7, checklist 2.5): user code that never
		// touches `wf.*` (pure infinite loop) trips `tick_timeout`, not a
		// budget. `Promise.race` — the loser keeps running in the
		// background, but the tick persists the timeout and returns, so
		// Vercel never hangs. The timer is unref'd: a fast tick must not
		// hold the invocation open for the full window.
		let timeout: ReturnType<typeof setTimeout> | undefined
		const timeoutP =
			tickMaxMs > 0
				? new Promise<never>((_, reject) => {
						timeout = setTimeout(() => {
							const sentinel = { kind: 'step-error', code: 'tick_timeout' } as const
							state.outcomes.set(state.counter, { ...sentinel, idx: state.counter })
							reject({ ...sentinel, [CONTROL_FLOW_TAG]: true })
						}, tickMaxMs)
						;(timeout as unknown as { unref?: () => void }).unref?.()
					})
				: null
		let out: unknown
		try {
			out = timeoutP ? await Promise.race([runWithMemos(), timeoutP]) : await runWithMemos()
		} finally {
			if (timeout) clearTimeout(timeout)
		}
		// R0: guard the success path too — opens pending but fn returned
		// means user code swallowed a sentinel.
		if (hasControlFlowOutcome(state.outcomes)) {
			const res = await failRun('swallowed_sentinel')
			emitEvent(state, { type: 'run_status', status: 'error' })
			return res
		}
		// W-O return-value check (specs §3.1, checklist 9.2): the
		// workflow's return value must satisfy the registered
		// `outputSchema` before the tick persists `done`. Mismatch →
		// terminal `error('output_mismatch')`, never a coerced `done`.
		if (outputSchema) {
			const check = outputSchema.safeParse(out)
			if (!check.success) {
				const res = await failRun('output_mismatch')
				emitEvent(state, { type: 'run_status', status: 'error' })
				return res
			}
			out = (check as { data: unknown }).data
		}
		await flushMemoWrites(state)
		await flushLogLines(state, run.tick + 1)
		await sql`
			UPDATE workflow_runs
			SET status = 'done', return_json = ${JSON.stringify(out)}::jsonb, updated_at = NOW()
			WHERE id = ${runId}`
		emitEvent(state, { type: 'run_status', status: 'done' })
		return { status: 'done', returnValue: out, opened: committedOpens(state) }
	} catch (e) {
		// Collection FIRST (§3.6): a semaphore StepError recorded at open
		// time beats whatever sentinel this particular `await` propagates.
		// `Promise.all` first-rejection order is NOT trusted. Budget
		// StepErrors are recorded in `state.outcomes` by the gate, so
		// they surface here even when the throwing handle is one of
		// several in a `wf.all` batch (the batch's Suspend must not win).
		const collected = collectOutcome(state.outcomes)
		if (collected.stepError) {
			const res = await failRun(collected.stepError.code)
			emitEvent(state, { type: 'run_status', status: 'error' })
			return res
		}
		if (isControlFlow(e)) {
			if (collected.suspended) {
				await flushMemoWrites(state)
				await flushLogLines(state, run.tick + 1)
				await sql`
					UPDATE workflow_runs
					SET status = 'waiting', tick = tick + 1, updated_at = NOW()
					WHERE id = ${runId}`
				emitEvent(state, { type: 'run_status', status: 'waiting' })
				return { status: 'waiting', opened: committedOpens(state) }
			}
			// Swallowed sentinel with no suspend recorded: terminal, and
			// the stream must still see the terminal `run_status`.
			const res = await failRun('swallowed_sentinel')
			emitEvent(state, { type: 'run_status', status: 'error' })
			return res
		}
		if (e instanceof InteractionFailed) {
			const res = await failRun(e.message)
			emitEvent(state, { type: 'run_status', status: 'error' })
			return res
		}
		const res = await failRun('workflow_throw')
		emitEvent(state, { type: 'run_status', status: 'error' })
		return res
	}
}

/**
 * Install the `unhandledRejection` sentinel guard (R2): a floating
 * `wf.*` handle rejects with a control-flow sentinel — convert it into a
 * no-crash no-op instead of killing the invocation. Returns an uninstall
 * function. Document `@typescript-eslint/no-floating-promises` for `wf.*`
 * (linted, not runtime).
 *
 * NOTE: the guard only covers sentinels that reject while NO handler is
 * attached. `wf.all` attaches handlers via `Promise.allSettled`, so its
 * handles never reach this path — but a bare `wf.use.tool()` call whose
 * caller never awaits (e.g. the memo-warm probe aborting mid-fan-out)
 * rejects with NO handler at all, and Node reports it as an unhandled
 * rejection. Tests that exercise that path must install this guard.
 */
export function installSentinelRejectionGuard(): () => void {
	const handler = (reason: unknown) => {
		if (isControlFlow(reason)) return
	}
	process.on('unhandledRejection', handler)
	return () => process.off('unhandledRejection', handler)
}
