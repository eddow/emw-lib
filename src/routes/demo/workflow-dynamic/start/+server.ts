import { createMockRun } from '../mock-state.js'
import type { RequestHandler } from './$types'

/**
 * `POST /demo/workflow-dynamic/start` — create a mock run, return immediately.
 * Same wire shape as the real `start` route
 * (`{ runId, deploymentUrl, status, stream }`), where `stream` is the
 * run-stream credential (`{ run_id, stream_token, stream_url }`) — the
 * `stream_url` points at the mock `/wfstreams` SSE route so
 * `AlfredClient` derives the base URL correctly.
 */
export const POST: RequestHandler = async ({ url }) => {
	const run = createMockRun()
	return Response.json({
		runId: run.id,
		deploymentUrl: url.origin,
		status: run.status,
		stream: {
			run_id: run.id,
			stream_token: 'e2e-token',
			stream_url: `${url.origin}/demo/workflow-dynamic/wfstreams/${run.id}`,
		},
	})
}
