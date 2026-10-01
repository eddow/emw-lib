import { __mockState } from '../../../mock-state.js'
import type { RequestHandler } from './$types'

/** `GET /demo/chat-dynamic/streams/:gid/answers` — posted mock answers (S8 harness). */
export const GET: RequestHandler = async ({ params }) => {
	const gid = params.gid ?? ''
	const g = __mockState().generations.get(gid)
	return Response.json({ answers: g?.answers ?? [] })
}
