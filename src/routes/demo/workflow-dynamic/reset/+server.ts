import { __mockWorkflowState } from '../mock-state.js'
import type { RequestHandler } from './$types'

/** `POST /demo/workflow-dynamic/reset` — per-test isolation (arms only; runs self-isolate by id). */
export const POST: RequestHandler = async () => {
	__mockWorkflowState().resetAll()
	return Response.json({ ok: true })
}
