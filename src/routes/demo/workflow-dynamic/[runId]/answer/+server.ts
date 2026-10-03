import { answerMockRun, getMockRun } from '../../mock-state.js'
import type { RequestHandler } from './$types'

/** `POST /demo/workflow-dynamic/[runId]/answer` — answer the `ask-human` row. */
export const POST: RequestHandler = async ({ params, request }) => {
	const runId = params.runId?.trim() ?? ''
	if (!getMockRun(runId)) {
		return Response.json({ message: `run not found: ${runId}` }, { status: 404 })
	}
	const body = (await request.json().catch(() => null)) as {
		idx?: unknown
		answer?: unknown
	} | null
	const idx = typeof body?.idx === 'number' && Number.isInteger(body.idx) ? body.idx : NaN
	if (!Number.isInteger(idx) || idx < 0) {
		return Response.json({ message: 'idx is required' }, { status: 400 })
	}
	if (!('answer' in (body ?? {}))) {
		return Response.json({ message: 'answer is required' }, { status: 400 })
	}
	const row = answerMockRun(runId, idx, body?.answer)
	if (!row) return Response.json({ message: `interaction ${idx} is not open` }, { status: 409 })
	// Same wire shape as the real `answer` route (which re-ticks past the
	// row); the mock answers without ticking, so `returnValue` is the run's
	// current output (`null` until `done`).
	return Response.json({ runId, idx, status: row.status, returnValue: getMockRun(runId)?.output ?? null })
}
