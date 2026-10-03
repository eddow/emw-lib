import { getMockRun } from '../../../mock-state.js'
import type { RequestHandler } from './$types'

/**
 * `GET /demo/workflow-dynamic/wfstreams/:rid/poll` — mock run-stream
 * poll fallback. Same wire shape as Alfred's
 * `GET /wfstreams/{rid}/poll` (`{events, next_seq, timeout}`), so
 * `AlfredClient.pollWorkflowEvents` works unchanged. One JSON batch,
 * no waiting — the mock has no long-poll (the SSE path is the
 * exercised transport; this exists only for the fallback shape).
 */
export const GET: RequestHandler = async ({ params, url }) => {
	const rid = params.rid?.trim() ?? ''
	const run = getMockRun(rid)
	if (!run) return Response.json({ message: `run not found: ${rid}` }, { status: 404 })
	const raw = url.searchParams.get('after_seq') ?? '0'
	const afterSeq = Number.parseInt(raw, 10)
	if (!Number.isInteger(afterSeq) || afterSeq < 0) {
		return Response.json({ message: 'after_seq is required' }, { status: 400 })
	}
	const events = run.events.filter((e) => e.seq >= afterSeq)
	return Response.json({
		events,
		next_seq: run.events.length > 0 ? run.events[run.events.length - 1].seq + 1 : afterSeq,
		timeout: events.length === 0,
	})
}
