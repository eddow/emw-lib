import { getMockRun } from '../../mock-state.js'
import type { RequestHandler } from './$types'

function sseBlock(event: Record<string, unknown>): Uint8Array {
	const type = typeof event.type === 'string' ? event.type : 'message'
	return new TextEncoder().encode(`event: ${type}\ndata: ${JSON.stringify(event)}\n\n`)
}

/**
 * `GET /demo/workflow-dynamic/wfstreams/:rid` — mock run-stream SSE.
 * Path shape mirrors Alfred (`/wfstreams/{rid}`) so `AlfredClient`
 * derives the base URL correctly from the credential's `stream_url`.
 *
 * Replays the run's durable event log since `?after_seq=` (wire shape
 * `{seq, type, payload}`), then holds the connection open: every
 * mutation (`tick`/`answer`/`cancel`/`fail` reactions) publishes into
 * the log and wakes this connection, so frames stream out live. A
 * terminal `run_status` ends the stream after delivery (same rule as
 * Alfred — replay stays available, only the live SSE closes).
 */
export const GET: RequestHandler = async ({ params, url }) => {
	const rid = params.rid?.trim() ?? ''
	const run = getMockRun(rid)
	if (!run) return Response.json({ message: `run not found: ${rid}` }, { status: 404 })
	const raw = url.searchParams.get('after_seq') ?? '0'
	const afterSeq = Number.parseInt(raw, 10)
	if (!Number.isInteger(afterSeq) || afterSeq < 0) {
		return Response.json({ message: 'after_seq is required' }, { status: 400 })
	}
	let cursor = afterSeq
	let closed = false
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			const flush = (): boolean => {
				// Replay + live share one cursor: everything since `cursor`
				// goes out in log order, then the cursor catches up.
				for (const evt of run.events) {
					if (evt.seq < cursor) continue
					try {
						controller.enqueue(sseBlock(evt))
					} catch {
						return false
					}
					cursor = evt.seq + 1
				}
				return true
			}
			const isTerminal = (): boolean => {
				const last = [...run.events].reverse().find((e) => e.type === 'run_status')
				const status = (last?.payload as { status?: string } | undefined)?.status
				return status === 'done' || status === 'error' || status === 'cancelled'
			}
			const onWake = (): void => {
				if (closed) return
				if (!flush()) return
				if (isTerminal()) {
					closed = true
					try {
						controller.close()
					} catch {
						// already closed — the reader sees EOF either way
					}
				} else {
					run.waiters.push(onWake)
				}
			}
			flush()
			if (isTerminal()) {
				closed = true
				try {
					controller.close()
				} catch {
					// already closed
				}
			} else {
				run.waiters.push(onWake)
			}
		},
		cancel() {
			closed = true
		},
	})
	return new Response(stream, {
		headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
	})
}
