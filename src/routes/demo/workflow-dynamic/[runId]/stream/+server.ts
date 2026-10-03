import type { WorkflowStreamEvent } from '$lib/workflows/types.js'
import { getMockRun } from '../../mock-state.js'
import type { RequestHandler } from './$types'

/** `GET /demo/workflow-dynamic/[runId]/stream?after_idx=N` — journal replay. */
export const GET: RequestHandler = async ({ params, url }) => {
	const runId = params.runId?.trim() ?? ''
	const run = getMockRun(runId)
	if (!run) return Response.json({ message: `run not found: ${runId}` }, { status: 404 })
	const raw = url.searchParams.get('after_idx') ?? '0'
	const afterIdx = Number.parseInt(raw, 10)
	if (!Number.isInteger(afterIdx) || afterIdx < 0) {
		return Response.json({ message: 'after_idx is required' }, { status: 400 })
	}
	const events: WorkflowStreamEvent[] = []
	for (const row of run.rows) {
		if (row.idx < afterIdx) continue
		events.push({
			type: 'interaction_opened',
			idx: row.idx,
			kind: row.kind,
			tool: row.tool ?? undefined,
			label: row.label,
			label_text: row.label_text,
		})
		if (row.status !== 'open') {
			events.push({ type: 'interaction_resolved', idx: row.idx, status: row.status })
		}
	}
	events.push({ type: 'run_status', status: run.status })
	return Response.json({
		runId,
		status: run.status,
		returnValue: run.output,
		error: run.error,
		next_idx: run.rows.length > 0 ? Math.max(...run.rows.map((r) => r.idx)) + 1 : afterIdx,
		events,
		askHuman: run.askHuman,
	})
}
