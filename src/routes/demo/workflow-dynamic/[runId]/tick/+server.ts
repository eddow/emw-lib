import { getMockRun, tickMockRun } from '../../mock-state.js'
import type { RequestHandler } from './$types'

/**
 * `POST /demo/workflow-dynamic/[runId]/tick` — advance the mock run one step.
 * When `hold` armed the run, sleeps ~400ms first so the FE's `ticking`
 * ("working…") indicator is observable mid-tick (W7).
 */
export const POST: RequestHandler = async ({ params }) => {
	const runId = params.runId?.trim() ?? ''
	const run = getMockRun(runId)
	if (!run) return Response.json({ message: `run not found: ${runId}` }, { status: 404 })
	if (run.held) {
		run.held = false
		await new Promise((r) => setTimeout(r, 400))
	}
	const fresh = tickMockRun(runId)
	return Response.json({
		runId,
		status: fresh?.status ?? run.status,
		returnValue: fresh?.output ?? null,
		error: fresh?.error ?? null,
		opened: [],
	})
}
