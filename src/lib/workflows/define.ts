/**
 * `defineAsyncWorkflow` — one workflow = one async function
 * (see `docs/workflows/README.md`).
 *
 * Client-safe: no `node:` imports, no env reads. Registration is an
 * in-memory map on the deploying bundle; the host tick driver resolves
 * the definition by name + version and re-executes `fn` every tick.
 */

import type { DescribeStepFn, SchemaLike, ToolRegistry, WFContext } from './types.js'

/**
 * One workflow input field — advisory form hint (plan `plans/workflow-ui.md` §1).
 * Display-only: the starter still validates the submitted object through the
 * workflow's own W-I `SchemaLike` when the author provides one.
 */
export interface WorkflowInputField {
	/** Must match a key of W-I; rendered as `<input name="...">`. */
	name: string
	type: 'text' | 'textarea' | 'number' | 'boolean' | 'select' | 'urls'
	required?: boolean
	/** `select` only. */
	options?: string[]
	/** English default placeholder; the app overrides via labels. */
	placeholder?: string
	defaultValue?: string | number | boolean | string[]
}

/** A registered async workflow definition. */
export interface AsyncWorkflowDef<
	W_I = unknown,
	W_O = unknown,
	R extends ToolRegistry = ToolRegistry,
> {
	readonly name: string
	readonly version: number
	readonly fn: (wf: WFContext<R>, input: W_I) => Promise<W_O>
	readonly describeStep: DescribeStepFn
	/**
	 * W-O return-value schema (specs §3.1, checklist 9.2): the tick
	 * validates the workflow's return value before persisting `done`.
	 * Optional — unregistered-output workflows skip the check.
	 */
	readonly outputSchema?: SchemaLike<unknown>
	/** English default picker label, e.g. `'Market analysis'`. */
	readonly title?: string
	/** English default one-liner for the picker. */
	readonly description?: string
	/** Advisory input form spec; absent = free JSON textarea fallback. */
	readonly inputSpec?: WorkflowInputField[]
	/** W-O key → English default title (app `outputLabels` merge over this). */
	readonly outputLabels?: Record<string, string>
}

/** Meta carried beside the function (name + version + display text). */
export interface AsyncWorkflowMeta {
	name: string
	version: number
	describeStep: DescribeStepFn
	/** W-O return-value schema (validated before `done` is persisted). */
	outputSchema?: SchemaLike<unknown>
	/** English default picker label, e.g. `'Market analysis'`. */
	title?: string
	/** English default one-liner for the picker. */
	description?: string
	/** Advisory input form spec; absent = free JSON textarea fallback. */
	inputSpec?: WorkflowInputField[]
	/** W-O key → English default title (app `outputLabels` merge over this). */
	outputLabels?: Record<string, string>
}

const registry = new Map<string, AsyncWorkflowDef<unknown, unknown, ToolRegistry>>()

function registryKey(name: string, version: number): string {
	return `${name}@${version}`
}

/**
 * Wrap an async workflow function with its meta and register it.
 * Returns the `{ name, version, fn, describeStep, ... }` definition.
 *
 * The registry is a module-level in-memory `Map` in this file, on the
 * server process: importing a workflow module (e.g. arb2b's
 * `marketAnalysis.ts` via `workflows/index.ts`) runs its top-level
 * `defineAsyncWorkflow(...)` call, which puts `{ name@version → def }`
 * in the map. Routes then resolve via `getAsyncWorkflow` / enumerate
 * via `listAsyncWorkflows` — so a page load itself adds nothing, it
 * only reads what the import already registered.
 *
 * Re-registering the identical function reference is a no-op (returns
 * the existing def): in dev, Vite HMR re-evaluates the workflow module
 * without re-evaluating this file, and a poisoned entry would otherwise
 * throw on every later request — including F5, which retries the failed
 * module evaluation against the stale map. Same source text (new closure
 * from re-evaluation) replaces the entry. A genuinely different function
 * under the same `name@version` still throws: it must never silently swap
 * the function a run replays against (replay runs byte-identical code by
 * deployment pinning, specs §8).
 */
export function defineAsyncWorkflow<W_I, W_O, R extends ToolRegistry = ToolRegistry>(
	fn: (wf: WFContext<R>, input: W_I) => Promise<W_O>,
	meta: AsyncWorkflowMeta
): AsyncWorkflowDef<W_I, W_O, R> {
	const key = registryKey(meta.name, meta.version)
	const existing = registry.get(key)
	if (existing) {
		if (existing.fn === fn) return existing as unknown as AsyncWorkflowDef<W_I, W_O, R>
		if (existing.fn.toString() === fn.toString()) {
			const def: AsyncWorkflowDef<W_I, W_O, R> = {
				name: meta.name,
				version: meta.version,
				fn,
				describeStep: meta.describeStep,
				outputSchema: meta.outputSchema,
				title: meta.title,
				description: meta.description,
				inputSpec: meta.inputSpec,
				outputLabels: meta.outputLabels,
			}
			registry.set(key, def as unknown as AsyncWorkflowDef<unknown, unknown, ToolRegistry>)
			return def
		}
		throw new Error(`async workflow already registered: ${key}`)
	}
	const def: AsyncWorkflowDef<W_I, W_O, R> = {
		name: meta.name,
		version: meta.version,
		fn,
		describeStep: meta.describeStep,
		outputSchema: meta.outputSchema,
		title: meta.title,
		description: meta.description,
		inputSpec: meta.inputSpec,
		outputLabels: meta.outputLabels,
	}
	registry.set(key, def as unknown as AsyncWorkflowDef<unknown, unknown, ToolRegistry>)
	return def
}

/** Look up a registered workflow by name + version. */
export function getAsyncWorkflow<
	W_I = unknown,
	W_O = unknown,
	R extends ToolRegistry = ToolRegistry,
>(name: string, version: number): AsyncWorkflowDef<W_I, W_O, R> | undefined {
	return registry.get(registryKey(name, version)) as AsyncWorkflowDef<W_I, W_O, R> | undefined
}

/** All registered workflows (deploy-time introspection for the tick driver). */
export function listAsyncWorkflows(): AsyncWorkflowDef<unknown, unknown, ToolRegistry>[] {
	return [...registry.values()]
}

/** Clear the registry (tests only). */
export function clearAsyncWorkflows(): void {
	registry.clear()
}
