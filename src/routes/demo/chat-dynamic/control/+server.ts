import { __mockState, closeGeneration, pushFrame, stopGeneration } from '../mock-state.js'
import type { RequestHandler } from './$types'

/**
 * `POST /demo/chat-dynamic/control?gid=…` — drive the mock chatbot.
 * Body `{kind, …}` pushes one frame; `?op=close|stop` ends the stream.
 */
export const POST: RequestHandler = async ({ url, request }) => {
	const gid = url.searchParams.get('gid') ?? 'gen_e2e_1'
	const op = url.searchParams.get('op')
	if (op === 'close') {
		closeGeneration(gid)
		return Response.json({ ok: true })
	}
	if (op === 'stop' || op === 'steer' || op === 'interrupt' || op === 'queue') {
		if (op === 'stop') stopGeneration(gid)
		return Response.json({ ok: true })
	}
	const frame = (await request.json().catch(() => null)) as Parameters<typeof pushFrame>[1] | null
	if (!frame || typeof frame.kind !== 'string') {
		return Response.json({ error: 'frame {kind,…} required' }, { status: 400 })
	}
	const { attached, closed } = pushFrame(gid, frame)
	const g = __mockState().generations.get(gid)
	return Response.json({ ok: !closed, attached, closed, queued: g?.queue.length ?? 0 })
}

void __mockState
