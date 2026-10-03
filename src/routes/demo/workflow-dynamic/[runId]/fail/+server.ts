import { failMockRun, getMockRun } from '../../mock-state.js'
import type { RequestHandler } from './$types'

/** `POST /demo/workflow-dynamic/[runId]/fail` — arm the mock run to error on next tick. */
export const POST: RequestHandler = async ({ params }) => {
	const runId = params.runId?.trim() ?? ''
	const run = getMockRun(runId)
	if (!run) return Response.json({ message: `run not found: ${runId}` }, { status: 404 })
	failMockRun(runId)
	return Response.json({ ok: true })
}
