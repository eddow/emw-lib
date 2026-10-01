import { recordAnswer } from '../../../../mock-state.js'
import type { RequestHandler } from './$types'

/**
 * `POST /demo/chat-dynamic/streams/:gid/answer/:toolCallId` — mock human-answer
 * endpoint (S8 harness). Mirrors Alfred's `POST /streams/{gid}/answer/{toolCallId}`
 * path so `AlfredClient.answerHuman` targets it with no client changes.
 * Records the posted body for the e2e to assert, then replies `{ok: true}`.
 */
export const POST: RequestHandler = async ({ params, request }) => {
	const gid = params.gid ?? ''
	const toolCallId = params.toolCallId ?? ''
	const body = (await request.json().catch(() => null)) as unknown
	recordAnswer(gid, toolCallId, body)
	return Response.json({ ok: true, duplicate: false, status: 'answered', value: body })
}
