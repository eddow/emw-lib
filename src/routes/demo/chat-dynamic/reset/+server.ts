import { __mockState } from '../mock-state.js'
import type { RequestHandler } from './$types'

/** `POST /demo/chat-dynamic/reset` — clear all mock generations (test isolation). */
export const POST: RequestHandler = async () => {
	__mockState().resetAll()
	return Response.json({ ok: true })
}
