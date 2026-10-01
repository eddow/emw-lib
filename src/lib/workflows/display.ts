/**
 * Workflow display helpers — FE catalogue support
 * (plan `plans/workflow-ui.md` §1).
 *
 * Client-safe: no `node:` imports, no env reads. Pure functions over the
 * run journal / stream vocabulary, so both the lib Svelte components and
 * host routes can share them. Tested in the `server` vitest project.
 */

/** Minimal progress row: the FE never needs `input_json`/`output_json`. */
export interface WorkflowInteractionLite {
	idx: number
	kind: 'prompt' | 'tool' | 'session'
	tool?: string | null
	label: string
	label_text: string
	status: 'open' | 'resolved' | 'failed' | 'cancelled' | 'expired'
}

/** One normalised W-O entry for the generic output `<dl>`. */
export interface WorkflowOutputEntry {
	key: string
	title: string
	value: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Normalise a run's `return_json` into output entries.
 *
 * Records render entry-per-key; scalars/arrays wrap as `{ result: value }`
 * so string-W-O workflows (e.g. `marketAnalysis`) share the `<dl>` code
 * path with record-W-O ones (e.g. `triagePages`). Titles resolve
 * `appLabels[key] ?? defLabels[key] ?? key` (`'result'` defaults to
 * `'Result'` when neither map names it).
 */
export function normalizeWorkflowOutput(
	output: unknown,
	opts?: { defLabels?: Record<string, string>; appLabels?: Record<string, string> }
): WorkflowOutputEntry[] {
	const record = isRecord(output) ? output : { result: output }
	return Object.entries(record).map(([key, value]) => ({
		key,
		title: opts?.appLabels?.[key] ?? opts?.defLabels?.[key] ?? (key === 'result' ? 'Result' : key),
		value,
	}))
}

/**
 * Group consecutive interaction idxs into parallel lines.
 *
 * The tick driver opens fan-out batches back-to-back (consecutive idxs
 * with no resolve between them); the FE renders each group as one
 * responsive grid line. Input is the open order (ascending idxs).
 */
export function groupParallelOpens(idxs: number[]): number[][] {
	const groups: number[][] = []
	for (const idx of idxs) {
		const last = groups[groups.length - 1]
		const prev = last?.[last.length - 1]
		if (last && prev !== undefined && idx === prev + 1) last.push(idx)
		else groups.push([idx])
	}
	return groups
}
