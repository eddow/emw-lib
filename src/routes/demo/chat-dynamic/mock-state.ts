/**
 * Controllable mock SSE chatbot for the dynamic-chat e2e
 * (`src/routes/demo/chat-dynamic/chat-dynamic.e2e.ts`).
 *
 * One `ReadableStream` per generation id, fed by `POST /control` (`emit`
 * pushes one frame, `op=close` ends the stream, `op=stop` aborts it).
 * Frames use the Alfred wire shape (`butler/docs/alfred.md` §4): deltas
 * carry `stream_id`, durable events carry generation-local `seq`.
 */

type Frame =
	| { kind: 'thought_delta' | 'answer_delta'; text: string }
	| { kind: 'thought' | 'answer'; text: string }
	| { kind: 'tool_use'; tool_call_id: string; name: string; args: unknown }
	| { kind: 'tool_result'; tool_call_id: string; name: string; output: unknown }
	| { kind: 'human_question'; tool_call_id: string }
	| { kind: 'human_answer'; tool_call_id: string }
	| { kind: 'done'; reason: string }
	| { kind: 'error'; error: string }

interface Generation {
	controller: ReadableStreamDefaultController<Uint8Array> | null
	seq: number
	closed: boolean
	/** Pre-encoded SSE blocks (seq stamped at push time — never re-encoded). */
	queue: Uint8Array[]
	waiters: (() => void)[]
	/** Answers posted via the mock `answer` endpoint, keyed by `tool_call_id`. */
	answers: { toolCallId: string; body: unknown }[]
}

const generations = new Map<string, Generation>()
let failNext: { status: number; detail: string } | null = null
/** Per-generation failure: `POST /control-fail { gid, … }` fails only that
 * generation's stream GET. Unlike the global `failNext` one-shot (which any
 * parallel worker's attach can consume), a per-gid arm cannot leak across
 * tests sharing the preview server process. */
const failByGid = new Map<string, { status: number; detail: string }>()
/** Monotonic id so every `prompt` gets a fresh stream even across page reloads. */
let nextN = 0

export function freshGid(): string {
	nextN += 1
	return `gen_e2e_${nextN}_${Date.now().toString(36)}`
}

function generation(gid: string): Generation {
	let g = generations.get(gid)
	if (!g) {
		g = { controller: null, seq: 0, closed: false, queue: [], waiters: [], answers: [] }
		generations.set(gid, g)
	}
	return g
}

function toEvent(g: Generation, frame: Frame, gid: string): Record<string, unknown> {
	switch (frame.kind) {
		case 'thought_delta':
		case 'answer_delta':
			return { type: frame.kind, stream_id: gid, stream_seq: g.seq, text: frame.text }
		case 'thought':
		case 'answer':
			g.seq += 1
			return { seq: g.seq, type: frame.kind, payload: { text: frame.text }, ts: 't' }
		case 'tool_use':
			g.seq += 1
			return {
				seq: g.seq,
				type: 'tool_use',
				payload: { tool_call_id: frame.tool_call_id, name: frame.name, arguments: frame.args },
				ts: 't',
			}
		case 'tool_result':
			g.seq += 1
			return {
				seq: g.seq,
				type: 'tool_result',
				payload: { tool_call_id: frame.tool_call_id, name: frame.name, output: frame.output },
				ts: 't',
			}
		case 'human_question':
			g.seq += 1
			return {
				seq: g.seq,
				type: 'human_question',
				payload: {
					tool_call_id: frame.tool_call_id,
					name: 'ask_human',
					questions: [{ id: 'q', text: 'Pick?', options: ['a', 'b'] }],
					timeout_s: 0,
					on_timeout: 'autopick',
				},
				ts: 't',
			}
		case 'human_answer':
			g.seq += 1
			return {
				seq: g.seq,
				type: 'human_answer',
				payload: {
					tool_call_id: frame.tool_call_id,
					tool_name: 'ask_human',
					timed_out: false,
					autopicked: false,
					answers: [{ id: 'q', choice: 'a', autopicked: false, timed_out: false }],
				},
				ts: 't',
			}
		case 'done':
			g.seq += 1
			return { seq: g.seq, type: 'done', payload: { reason: frame.reason }, ts: 't' }
		case 'error':
			g.seq += 1
			return { seq: g.seq, type: 'error', payload: { error: frame.error }, ts: 't' }
	}
}

function sseBlock(event: Record<string, unknown>): Uint8Array {
	const type = typeof event.type === 'string' ? event.type : 'message'
	return new TextEncoder().encode(`event: ${type}\ndata: ${JSON.stringify(event)}\n\n`)
}

export function __mockState() {
	return {
		generations,
		getFailNext: () => failNext,
		setFailNext: (v: typeof failNext) => (failNext = v),
		getFailGid: (gid: string) => failByGid.get(gid),
		setFailGid: (gid: string, v: { status: number; detail: string } | null) => {
			if (v) failByGid.set(gid, v)
			else failByGid.delete(gid)
		},
		resetAll: () => {
			// NOTE: generations are keyed by fresh monotonic gids (never
			// reused), so tests are self-isolating WITHOUT clearing the map.
			// Clearing here is actively harmful: under parallel workers (or
			// Playwright's repeat interleaving) one test's `reset` deletes
			// another test's in-flight generation mid-attach, and its
			// `waitAttached` times out. Only the failure arms are reset.
			failNext = null
			failByGid.clear()
		},
	}
}

export function pushFrame(gid: string, frame: Frame): { attached: boolean; closed: boolean } {
	const g = generation(gid)
	// Terminal event already sent — late frames are dropped (mirrors Alfred
	// closing the stream). The ack reports it so tests can assert the emit
	// actually landed instead of timing out on a missing bubble.
	if (g.closed) return { attached: !!g.controller, closed: true }
	// Encode at push time (seq stamped now) and deliver or queue BYTES.
	// Queueing bytes (never frames) fixes the emit/send race: two rapid
	// `emit()` calls encode in POST-arrival order, and the flush path can
	// never re-encode and bump `seq` twice (delta-loss bug).
	const bytes = sseBlock(toEvent(g, frame, gid))
	if (g.controller) {
		try {
			g.controller.enqueue(bytes)
		} catch {
			g.queue.push(bytes)
		}
	} else {
		g.queue.push(bytes)
	}
	if (frame.kind === 'done' || frame.kind === 'error') {
		// Terminal: close AFTER enqueueing so the client's SSE loop ends
		// and `status` settles (mirrors Alfred closing the stream).
		closeGeneration(gid)
		return { attached: !!g.controller, closed: false }
	}
	for (const w of g.waiters.splice(0)) w()
	return { attached: !!g.controller, closed: false }
}

export function closeGeneration(gid: string): void {
	const g = generation(gid)
	g.closed = true
	try {
		g.controller?.close()
	} catch {
		// already closed — the reader sees EOF either way
	}
	for (const w of g.waiters.splice(0)) w()
}

/** Flush frames queued before the reader attached (called from `start()`). */
export function flushQueue(gid: string): void {
	const g = generation(gid)
	if (!g.controller || g.closed) return
	for (const bytes of g.queue.splice(0)) {
		try {
			g.controller.enqueue(bytes)
		} catch {
			g.queue.unshift(bytes)
			break
		}
	}
}

export function stopGeneration(gid: string): void {
	// `stop` aborts the in-flight stream without a terminal event: the
	// client's SSE loop ends (dispose) while the transcript is kept.
	closeGeneration(gid)
}

/** Record an answer posted to the mock `answer` endpoint (S8 harness). */
export function recordAnswer(gid: string, toolCallId: string, body: unknown): void {
	generation(gid).answers.push({ toolCallId, body })
}
