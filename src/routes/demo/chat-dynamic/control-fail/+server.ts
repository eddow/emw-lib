import { __mockState } from '../mock-state.js'
import type { RequestHandler } from './$types'

/**
 * `POST /demo/chat-dynamic/control-fail` — fail a stream GET.
 * Body `{ gid?, status?, detail? }`: with `gid` the failure arms ONLY that
 * generation (parallel-safe — no cross-test leakage through the shared
 * preview server); without it, the legacy global one-shot (next GET wins).
 */
export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json().catch(() => null)) as {
		gid?: unknown
		status?: unknown
		detail?: unknown
	} | null
	const status = typeof body?.status === 'number' ? body.status : 410
	const detail = typeof body?.detail === 'string' ? body.detail : 'generation ended'
	if (typeof body?.gid === 'string' && body.gid) {
		__mockState().setFailGid(body.gid, { status, detail })
	} else {
		__mockState().setFailNext({ status, detail })
	}
	return Response.json({ ok: true })
}
