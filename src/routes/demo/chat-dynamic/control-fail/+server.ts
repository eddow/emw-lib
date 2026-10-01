import { __mockState } from '../mock-state.js'
import type { RequestHandler } from './$types'

/**
 * `POST /demo/chat-dynamic/control-fail` — fail a stream GET.
 * Body `{ gid, status?, detail? }`: the failure arms ONLY that generation
 * (parallel-safe — no cross-test leakage through the shared preview
 * server). `gid` is required: there is no global one-shot.
 */
export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json().catch(() => null)) as {
		gid?: unknown
		status?: unknown
		detail?: unknown
	} | null
	if (typeof body?.gid !== 'string' || !body.gid) {
		return Response.json({ error: 'gid is required' }, { status: 400 })
	}
	const status = typeof body?.status === 'number' ? body.status : 410
	const detail = typeof body?.detail === 'string' ? body.detail : 'generation ended'
	__mockState().setFailGid(body.gid, { status, detail })
	return Response.json({ ok: true })
}
