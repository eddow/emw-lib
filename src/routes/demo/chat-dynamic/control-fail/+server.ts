import { __mockState } from '../mock-state.js'
import type { RequestHandler } from './$types'

/** `POST /demo/chat-dynamic/control-fail` — fail the NEXT stream GET. */
export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json().catch(() => null)) as {
		status?: unknown
		detail?: unknown
	} | null
	const status = typeof body?.status === 'number' ? body.status : 410
	const detail = typeof body?.detail === 'string' ? body.detail : 'generation ended'
	__mockState().setFailNext({ status, detail })
	return Response.json({ ok: true })
}
