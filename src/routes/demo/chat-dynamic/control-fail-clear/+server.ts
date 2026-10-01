import { __mockState } from '../mock-state.js'
import type { RequestHandler } from './$types'

/** `POST /demo/chat-dynamic/control-fail-clear` — disarm a pending `failNext`. */
export const POST: RequestHandler = async () => {
	__mockState().setFailNext(null)
	return Response.json({ ok: true })
}
