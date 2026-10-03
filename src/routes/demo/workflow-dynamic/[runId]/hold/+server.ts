import { getMockRun, holdMockRun } from '../../mock-state.js'
import type { RequestHandler } from './$types'

/** `POST /demo/workflow-dynamic/[runId]/hold` — arm the next `tick` to sleep ~400ms (W7). */
export const POST: RequestHandler = async ({ params }) => {
	const runId = params.runId?.trim() ?? ''
	if (!getMockRun(runId)) {
		return Response.json({ message: `run not found: ${runId}` }, { status: 404 })
	}
	holdMockRun(runId)
	return Response.json({ ok: true })
}
