import { getMockRun } from '../../mock-state.js'
import type { RequestHandler } from './$types'

/**
 * `GET /demo/workflow-dynamic/[runId]/status` — journal truth for the
 * SSE pane (mirrors the real hosts' `status` route): terminal payload
 * + ask-human questions/options, neither of which crosses the run
 * stream. The pane fetches this on mount (seed) and again when the
 * stream's `run_status` turns terminal (payload).
 */
export const GET: RequestHandler = async ({ params }) => {
	const runId = params.runId?.trim() ?? ''
	const run = getMockRun(runId)
	if (!run) return Response.json({ message: `run not found: ${runId}` }, { status: 404 })
	return Response.json({
		status: run.status,
		returnValue: run.output,
		error: run.error,
		interactions: run.rows.map((r) => ({
			idx: r.idx,
			kind: r.kind,
			tool: r.tool ?? null,
			label: r.label,
			label_text: r.label_text,
			status: r.status === 'open' ? 'open' : 'resolved',
		})),
		askHuman: run.askHuman,
	})
}
