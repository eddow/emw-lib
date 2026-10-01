import { describe, expect, it, vi } from 'vitest'
import { AlfredClient, AlfredError } from './client.js'
import { GenerationStream } from './session.svelte.js'
import type { FetchFn, StreamCredential } from './types.js'

// ---------------------------------------------------------------------------
// A mocked transport: JSON for BE calls, an SSE body for `/streams/*`.
// ---------------------------------------------------------------------------

/** Encode SSE frames into a `ReadableStream` body. */
function sseBody(frames: string[]): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder()
	return new ReadableStream({
		start(controller) {
			for (const frame of frames) controller.enqueue(encoder.encode(frame))
			controller.close()
		},
	})
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	})
}

/** A fetch mock: `/streams` streams `frames`, else `json`. */
function mockFetch(frames: string[] = [], json: unknown = { ok: true }) {
	const calls: { url: string; init?: RequestInit }[] = []
	const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input)
		calls.push({ url, init })
		if (url.includes('/streams/')) return new Response(sseBody(frames), { status: 200 })
		return jsonResponse(json)
	})
	return { fn: fn as unknown as FetchFn, calls }
}

/** Poll until `pred()` holds (the SSE loop ingests asynchronously). */
async function waitFor(pred: () => boolean, ms = 500): Promise<void> {
	const start = Date.now()
	while (!pred()) {
		if (Date.now() - start > ms) throw new Error('waitFor timed out')
		await new Promise((r) => setTimeout(r, 5))
	}
}

const CRED: StreamCredential = {
	generation_id: 'gen_1',
	stream_token: 'tok-1',
	stream_url: 'http://localhost:8192/streams/gen_1',
}

const DELTA = (text: string, seq: number) =>
	`event: answer_delta\ndata: ${JSON.stringify({
		type: 'answer_delta',
		stream_id: 'gen_1',
		stream_seq: seq,
		text,
	})}\n\n`

const ANSWER = (text: string, seq: number) =>
	`event: answer\ndata: ${JSON.stringify({
		seq,
		type: 'answer',
		payload: { text },
		ts: '2026-09-28T10:00:00Z',
	})}\n\n`

const DONE = (seq: number) =>
	`event: done\ndata: ${JSON.stringify({ seq, type: 'done', payload: { reason: 'stop' }, ts: 't' })}\n\n`

function stream(fn: FetchFn, autoStream = true, eventLogLimit?: number) {
	return new GenerationStream({
		client: new AlfredClient({ fetchFn: fn }),
		autoStream,
		eventLogLimit,
	})
}

// ---------------------------------------------------------------------------

describe('attach / reduce', () => {
	it('attaches a credential, streams the answer and flips status on done', async () => {
		const { fn, calls } = mockFetch([ANSWER('hi', 1), DONE(2)])
		const s = stream(fn)

		await s.attach(CRED)
		await s.attached

		expect(s.id).toBe('gen_1')
		expect(s.status).toBe('done')
		// The durable final renders via `events`, not the draft (draft consumed).
		expect(s.text).toBe('')
		expect(s.events.map((e) => e.type)).toEqual(['answer', 'done'])
		expect(calls[0].url).toBe('http://localhost:8192/streams/gen_1?after_seq=0')
		expect(new Headers(calls[0].init?.headers).get('authorization')).toBe('Bearer tok-1')
	})

	it('appends deltas, consumes the draft on the durable answer', async () => {
		const { fn } = mockFetch([DELTA('Hel', 1), DELTA('lo', 2), ANSWER('Hello world', 3), DONE(4)])
		const s = stream(fn)
		await s.attach(CRED)
		await s.attached

		// Draft consumed by the durable final; the final text lives in `events`.
		expect(s.text).toBe('')
		expect(s.lastSeq).toBe(4)
		expect(s.status).toBe('done')
		expect(s.events).toHaveLength(4)
	})

	it('reconnects from the durable cursor, not from zero', async () => {
		const { fn, calls } = mockFetch([ANSWER('again', 9), DONE(10)])
		const s = stream(fn)
		await s.attach(CRED)
		await s.attached
		await s.attach(CRED)
		await s.attached

		// lastSeq is 10 after the first pass (the `done` event), so replay resumes there.
		expect(calls[1].url).toContain('after_seq=10')
	})

	it('surfaces a stream failure as status error + message', async () => {
		const fn = vi.fn(async () => jsonResponse({ detail: 'generation ended' }, 410))
		const s = stream(fn as unknown as FetchFn)
		await s.attach(CRED)
		await s.attached

		expect(s.status).toBe('error')
		expect(s.error).toBe('generation ended')
	})

	it('rejects attach without an id', async () => {
		const { fn } = mockFetch()
		const s = stream(fn)
		await expect(s.attach(null)).rejects.toBeInstanceOf(AlfredError)
	})
})

describe('refreshStream', () => {
	/** A fetch that 401s until the token matches `good`, then succeeds. */
	function authFetch(good: string) {
		const calls: { url: string; auth: string | null }[] = []
		const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input)
			const auth = new Headers(init?.headers).get('authorization')
			calls.push({ url, auth })
			if (auth !== `Bearer ${good}`) return jsonResponse({ detail: 'expired' }, 401)
			if (url.includes('/streams/')) return new Response(sseBody([ANSWER('hi', 1), DONE(2)]))
			return jsonResponse({ ok: true })
		})
		return { fn: fn as unknown as FetchFn, calls }
	}

	it('refreshes the stream capability on 401/410 and retries once', async () => {
		const { fn, calls } = authFetch('fresh')
		const refresh = vi.fn(async () => ({ ...CRED, stream_token: 'fresh' }))
		const s = new GenerationStream({
			client: new AlfredClient({ fetchFn: fn }),
			refreshStream: refresh,
		})
		// attach installs CRED's token (tok-1); the mock 401s until 'fresh'.
		await s.attach(CRED)
		await s.attached

		expect(refresh).toHaveBeenCalledTimes(1)
		expect(calls.map((c) => c.auth)).toEqual(['Bearer tok-1', 'Bearer fresh'])
		expect(s.status).toBe('done')
	})
})

describe('event log bound', () => {
	it('keeps durable events and trims the oldest deltas', async () => {
		const frames = [DELTA('a', 1), DELTA('b', 2), DELTA('c', 3), ANSWER('abc', 4), DONE(5)]
		const { fn } = mockFetch(frames)
		const s = stream(fn, true, 3)
		await s.attach(CRED)
		await s.attached

		// 5 events arrived, cap is 3 → the 2 oldest deltas were dropped.
		expect(s.events).toHaveLength(3)
		expect(s.events.map((e) => e.type)).toEqual(['answer_delta', 'answer', 'done'])
		// The durable record is intact; the draft was consumed by the final.
		expect(s.text).toBe('')
		expect(s.lastSeq).toBe(5)
	})

	it('eventLogLimit 0 disables the log but keeps the reducer working', async () => {
		const { fn } = mockFetch([DELTA('a', 1), ANSWER('a', 2), DONE(3)])
		const s = stream(fn, true, 0)
		await s.attach(CRED)
		await s.attached

		expect(s.events).toEqual([])
		// Draft consumed by the durable final even when the log is disabled.
		expect(s.text).toBe('')
		expect(s.lastSeq).toBe(3)
	})
})

describe('isStreaming', () => {
	it('tracks the connection', async () => {
		// A stream that stays open until aborted.
		const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			if (String(input).includes('/streams/')) {
				const body = new ReadableStream<Uint8Array>({
					start(controller) {
						init?.signal?.addEventListener('abort', () => controller.close())
					},
				})
				return new Response(body, { status: 200 })
			}
			return jsonResponse({ ok: true })
		}) as unknown as FetchFn
		const s = stream(fn)
		expect(s.isStreaming).toBe(false)

		void s.attach(CRED)
		await waitFor(() => s.isStreaming)
		expect(s.isStreaming).toBe(true)

		s.dispose()
		expect(s.isStreaming).toBe(false)
	})
})

describe('dispose / reset', () => {
	it('dispose aborts the loop without flipping to error', async () => {
		// A stream that never closes: the loop stays attached until aborted.
		const encoder = new TextEncoder()
		const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			if (String(input).includes('/streams/')) {
				const body = new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(encoder.encode(DELTA('a', 1)))
						init?.signal?.addEventListener('abort', () => controller.close())
					},
				})
				return new Response(body, { status: 200 })
			}
			return jsonResponse({ ok: true })
		}) as unknown as FetchFn
		const s = stream(fn)
		void s.attach(CRED)
		await waitFor(() => s.text === 'a')
		expect(s.text).toBe('a')

		s.dispose()
		await s.attached
		expect(s.status).not.toBe('error')
		expect(s.error).toBeNull()
	})

	it('reset clears every field', async () => {
		const { fn } = mockFetch([ANSWER('hi', 1), DONE(2)])
		const s = stream(fn)
		await s.attach(CRED)
		await s.attached

		s.reset()
		expect(s.id).toBeNull()
		expect(s.status).toBe('idle')
		expect(s.text).toBe('')
		expect(s.events).toEqual([])
		expect(s.error).toBeNull()
	})
})
