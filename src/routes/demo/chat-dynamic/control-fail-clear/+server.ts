import type { RequestHandler } from './$types'

/**
 * `POST /demo/chat-dynamic/control-fail-clear` — disarm a per-gid failure.
 * Body `{ gid }`. Kept for manual debugging; no test uses it (per-gid arms
 * are self-isolating, and the stream GET consumes its arm on attach).
 */
export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json().catch(() => null)) as { gid?: unknown } | null
	if (typeof body?.gid === 'string' && body.gid) {
		const { __mockState } = await import('../mock-state.js')
		__mockState().setFailGid(body.gid, null)
	}
	return Response.json({ ok: true })
}
