/**
 * asyncWF shared types — the workflow authoring surface
 * (`plans/asyncWF/specs.md` §2; build checklist Phase 0.1).
 *
 * Client-safe: no `node:` imports, no env reads. Both workflow code and host
 * tick drivers program against these shapes.
 *
 * Schemas stay zod-agnostic on purpose — `emw-lib` does not depend on zod.
 * {@link SchemaLike} is the minimal structural contract (`safeParse`) that
 * `z.ZodType<T>` satisfies, so workflow code passes its zod schemas
 * directly without this module importing zod.
 */

/** Serialized/replay form of a session id (an Alfred uuid string). */
export type SessionReference = string

/**
 * Minimal structural schema contract. `z.ZodType<T>` satisfies this, so the
 * same zod schema that validates an answer can be embedded in the prompt via
 * `z.toJSONSchema(...)` — one source of truth (specs §2.2).
 */
export interface SchemaLike<T> {
	safeParse(data: unknown): { success: true; data: T } | { success: false; error: unknown }
}

/** A tool call site: knows its tool name, typed input and output (specs §2, B1). */
export type ToolFn<I, O> = {
	(input: I, opts?: { label?: string }): Promise<O>
	readonly tool: string
}

/** One tool's payload shapes inside a {@link ToolRegistry}. */
export interface ToolRegistryEntry<I = unknown, O = unknown> {
	input: I
	output: O
}

/**
 * The single place tool names + payload types are declared. Declare
 * registries as `type` (not `interface`): object-literal types carry an
 * implicit index signature, interfaces do not.
 */
export type ToolRegistry = {
	[tool: string]: ToolRegistryEntry<unknown, unknown>
}

/** Typed tool call sites: `wf.use.serp_search(q)` (specs §2, B1). */
export type ToolFns<R extends ToolRegistry = ToolRegistry> = {
	[K in keyof R]: R[K] extends { input: infer I; output: infer O } ? ToolFn<I, O> : never
}

/**
 * Options common to every prompt. `expectedSchema` is the reserved key
 * that switches `prompt` to its structured overload (specs §2.2).
 */
export interface BasePromptOpts {
	/**
	 * Reserved: the schema the answer must satisfy. Its presence makes
	 * the runtime extract + validate on resolve and `prompt` return `T`.
	 */
	expectedSchema?: SchemaLike<unknown>
	/** JSON Schema the terminal answer must satisfy (validated on resolve). */
	responseFormat?: Record<string, unknown>
}

/** A session: owns its id and its prompt call sites (specs §4, B2). */
export interface Session {
	readonly id: SessionReference
	/** Structured answer: the runtime extracts + validates on resolve (specs §2.2). */
	prompt<T>(
		label: string,
		text: string,
		opts: BasePromptOpts & { expectedSchema: SchemaLike<T> }
	): Promise<T>
	/** Free-text answer. */
	prompt(label: string, text: string, opts?: BasePromptOpts): Promise<string>
}

/**
 * Input to `WFContext.createSession` (authoring shape; the driver maps it
 * onto the Alfred `POST /sessions` wire).
 */
export interface WFCreateSessionInput {
	model: string
	systemPrompt: string
	toolset?: { tools: { name: string }[] }
	initialPrompt: string
}

/** The workflow context: one async function receives it, `await` points are step boundaries. */
export interface WFContext<R extends ToolRegistry = ToolRegistry> {
	runId: string
	/**
	 * Typed tool call sites: `wf.use.serp_search(q)` (specs §2, B1).
	 * Built per tick, closing over the tick context.
	 */
	use: ToolFns<R>
	/** Create a session. Async: awaits Alfred `POST /sessions` on first tick (specs §4, R1). */
	createSession(input: WFCreateSessionInput): Promise<Session>
	/**
	 * Wait-for-all with fail-fast semantics (specs §3.6): rejects on the
	 * first element failure. Prefer over bare `Promise.all`.
	 */
	all<T>(handles: Promise<T>[]): Promise<T[]>
	/**
	 * Evaluate once, journal under `key`, replay cached (specs §2.3).
	 * Sync `fn` only; no `wf.*` calls and no I/O inside.
	 */
	once<T>(key: string, fn: () => T): T
	/** Journaled clock: `once('now', () => Date.now())` without naming non-determinism (specs §2.3). */
	now(): number
	/**
	 * Pure, deterministic extraction + parse + validation (specs §2.2).
	 * Throws {@link ParseError} (a normal, catchable `Error`) — never a
	 * control-flow sentinel.
	 */
	parseJson<T>(raw: string, schema: SchemaLike<T>): T
	/** Structured logbook line (append-only, one emission per tick per call site, specs §3.4). */
	log(message: string, data?: unknown): void
}

/** Args to the workflow's `describeStep` (specs §2.1). */
export interface DescribeStepArgs {
	label: string
	kind: 'prompt' | 'tool' | 'session'
	/** `use` only, e.g. `'serp_search'`. */
	tool?: string
	/** Truncated input (titles, counts — never blobs). */
	inputSummary?: unknown
}

/**
 * Pure display-text function: one canonical English sentence per call site.
 * Display-only — never part of replay identity.
 */
export type DescribeStepFn = (args: DescribeStepArgs) => string

/**
 * Deterministic parse/validation failure (specs §2.2). A normal, catchable
 * `Error` — never a control-flow sentinel.
 */
export class ParseError extends Error {
	readonly issues?: unknown
	constructor(message: string, issues?: unknown) {
		super(message)
		this.name = 'ParseError'
		this.issues = issues
	}
}

/**
 * A resolved tool/prompt error surfacing at its `await`. A normal `Error`:
 * may be caught per-element for local fallback; uncaught, it fails the run.
 */
export class InteractionFailed extends Error {
	readonly idx?: number
	readonly kind?: string
	readonly label?: string
	constructor(message: string, opts?: { idx?: number; kind?: string; label?: string }) {
		super(message)
		this.name = 'InteractionFailed'
		this.idx = opts?.idx
		this.kind = opts?.kind
		this.label = opts?.label
	}
}

/**
 * Well-known key marking control-flow sentinels. `Symbol.for` (not `Symbol`)
 * so the tag survives duplicate module copies (bundler duplication, HMR).
 */
export const CONTROL_FLOW_TAG = Symbol.for('asyncWF.controlFlow')

/** Driver control-flow signal: `suspend` (waiting) or `step-error` (terminal mapping). */
export interface ControlFlowSentinel {
	kind: 'suspend' | 'step-error'
	code: string
	idx?: number
}

/**
 * True for driver control-flow sentinels (`Suspend` / `StepError`, specs
 * §3.6). Never true for `Error` instances — workflow `catch` blocks MUST
 * rethrow anything passing this check; swallowing one is
 * `error('swallowed_sentinel')` (R0).
 */
export function isControlFlow(e: unknown): e is ControlFlowSentinel {
	if (typeof e !== 'object' || e === null) return false
	if (e instanceof Error) return false
	return (e as Record<symbol, unknown>)[CONTROL_FLOW_TAG] === true
}

/**
 * Throw a non-`Error` control-flow sentinel. User `catch` blocks must
 * rethrow it (see {@link isControlFlow}).
 */
export function throwControlFlow(sentinel: ControlFlowSentinel): never {
	throw { ...sentinel, [CONTROL_FLOW_TAG]: true }
}
