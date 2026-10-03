import { cancelMockRun, getMockRun } from '../../mock-state.js'
import type { RequestHandler } from './$types'

/** `POST /demo/workflow-dynamic/[runId]/cancel` — cancel the mock run. */
export const POST: RequestHandler = async ({ params }) => {
	const runId = params.runId?.trim() ?? ''
	const run = getMockRun(runId)
	if (!run) return Response.json({ message: `run not found: ${runId}` }, { status: 404 })
	const fresh = cancelMockRun(runId)
	return Response.json({ runId, status: fresh?.status ?? 'cancelled' })
}
