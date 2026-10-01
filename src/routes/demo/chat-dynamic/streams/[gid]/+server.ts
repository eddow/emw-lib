import { __mockState, flushQueue } from '../../mock-state.js'
import type { RequestHandler } from './$types'

/**
 * `GET /demo/chat-dynamic/streams/:gid` — controllable mock SSE chatbot.
 * Path shape mirrors Alfred (`/streams/{gid}`) so `AlfredClient`
 * derives the base URL correctly. Holds the connection open; frames
 * pushed via `POST /control?gid=…` stream out as Alfred wire events
 * (`butler/docs/alfred.md` §4). `?after_seq=` is accepted and ignored
 * (live frames only — history lives in the page's `AlfredChat`).
 */
export const GET: RequestHandler = async ({ params }) => {
	const gid = params.gid ?? 'gen_e2e_1'
	const { generations, getFailNext, setFailNext, getFailGid, setFailGid } = __mockState()
	// Per-generation arm wins (parallel-safe: only this gid's attach can
	// consume it); the legacy global one-shot is the fallback.
	const failGid = getFailGid(gid)
	if (failGid) {
		setFailGid(gid, null)
		return Response.json({ detail: failGid.detail }, { status: failGid.status })
	}
	const fail = getFailNext()
	if (fail) {
		setFailNext(null)
		return Response.json({ detail: fail.detail }, { status: fail.status })
	}
	let gen = generations.get(gid)
	if (!gen) {
		gen = { controller: null, seq: 0, closed: false, queue: [], waiters: [], answers: [] }
		generations.set(gid, gen)
	}
	const g = gen
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			g.controller = controller
			// Flush frames queued before the reader attached (emit/send race).
			flushQueue(gid)
		},
		cancel() {
			g.controller = null
		},
	})
	return new Response(stream, {
		headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
	})
}
