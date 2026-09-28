import { describe, expect, it, vi } from 'vitest'
import { AlfredClient, AlfredError } from './client.js'
import { ButlerSession } from './session.svelte.js'
import type { FetchFn } from './types.js'

// ---------------------------------------------------------------------------
// A mocked transport: JSON for control calls, an SSE body for `/events`.
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

/** A fetch mock: `/events` streams `frames`, `/history` returns `historyJson`, else `json`. */
function mockFetch(frames: string[] = [], json: unknown = { ok: true }, historyJson?: unknown) {
	const calls: { url: string; init?: RequestInit }[] = []
	const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input)
		calls.push({ url, init })
		if (url.includes('/events')) return new Response(sseBody(frames), { status: 200 })
		if (url.includes('/history')) return jsonResponse(historyJson ?? { events: [] })
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

const DELTA = (text: string, seq: number) =>
	`event: answer_delta\ndata: ${JSON.stringify({
		type: 'answer_delta',
		stream_id: 's1',
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

function session(fn: FetchFn, autoStream = true, eventLogLimit?: number) {
	return new ButlerSession({
		client: new AlfredClient({ fetchFn: fn }),
		autoStream,
		eventLogLimit,
	})
}

// ---------------------------------------------------------------------------

describe('create', () => {
	it('posts the session, sets id/status and attaches the stream', async () => {
		const { fn, calls } = mockFetch([ANSWER('hi', 1), DONE(2)], { session_id: 'sess-1' })
		const s = session(fn)

		const id = await s.create({ agent: { model: 'anthropic/claude-sonnet-4' } })
		await s.attached

		expect(id).toBe('sess-1')
		expect(s.id).toBe('sess-1')
		expect(s.status).toBe('done')
		expect(s.text).toBe('hi')
		expect(calls[0].url).toBe('http://localhost:8192/sessions')
		expect(calls[1].url).toContain('/sessions/sess-1/events?after_seq=0')
	})

	it('does not attach when autoStream is false', async () => {
		const { fn, calls } = mockFetch([], { session_id: 'sess-2' })
		const s = session(fn, false)
		await s.create({ agent: { model: 'm' } })
		expect(s.id).toBe('sess-2')
		expect(s.status).toBe('running')
		expect(calls).toHaveLength(1)
	})
})

describe('attach / reduce', () => {
	it('appends deltas, replaces with the durable answer, flips status on done', async () => {
		const { fn } = mockFetch([DELTA('Hel', 1), DELTA('lo', 2), ANSWER('Hello world', 3), DONE(4)])
		const s = session(fn)
		await s.attach('sess-1')
		await s.attached

		expect(s.text).toBe('Hello world')
		expect(s.lastSeq).toBe(4)
		expect(s.status).toBe('done')
		expect(s.events).toHaveLength(4)
	})

	it('reconnects from the durable cursor, not from zero', async () => {
		const { fn, calls } = mockFetch([ANSWER('again', 9), DONE(10)])
		const s = session(fn)
		await s.attach('sess-1')
		await s.attached
		await s.attach('sess-1')
		await s.attached

		// lastSeq is 10 after the first pass (the `done` event), so replay resumes there.
		expect(calls[1].url).toContain('after_seq=10')
	})

	it('surfaces a stream failure as status error + message', async () => {
		const fn = vi.fn(async () => jsonResponse({ detail: 'session not found: zz' }, 404))
		const s = session(fn as unknown as FetchFn)
		await s.attach('zz')
		await s.attached

		expect(s.status).toBe('error')
		expect(s.error).toBe('session not found: zz')
	})

	it('rejects attach without an id', async () => {
		const { fn } = mockFetch()
		const s = session(fn)
		await expect(s.attach(null)).rejects.toBeInstanceOf(AlfredError)
	})
})

describe('send', () => {
	it('routes queue / steer / redirect to distinct endpoints', async () => {
		const { fn, calls } = mockFetch([], { session_id: 'sess-1' })
		const s = session(fn, false)
		await s.create({ agent: { model: 'm' } })

		await s.send('a', 'queue')
		await s.send('b', 'steer')
		await s.send('c', 'redirect')

		expect(calls.map((c) => c.url)).toEqual([
			'http://localhost:8192/sessions',
			'http://localhost:8192/sessions/sess-1/queue',
			'http://localhost:8192/sessions/sess-1/steer',
			'http://localhost:8192/sessions/sess-1/redirect',
		])
		expect(JSON.parse(String(calls[1].init?.body))).toEqual({ prompt: 'a' })
	})

	it('throws before fetching when no session is attached', async () => {
		const { fn, calls } = mockFetch()
		const s = session(fn)
		await expect(s.send('x')).rejects.toMatchObject({ code: 'validation' })
		expect(calls).toHaveLength(0)
	})
})

describe('stop / resume / history', () => {
	it('stop pauses, resume re-attaches when autoStream is on', async () => {
		const { fn, calls } = mockFetch([DONE(1)], { session_id: 'sess-1' })
		const s = session(fn)
		await s.create({ agent: { model: 'm' } })
		await s.attached

		await s.stop()
		expect(s.status).toBe('paused')
		await s.resume()
		await s.attached
		expect(s.status).toBe('done')
		expect(calls.map((c) => c.url)).toContain('http://localhost:8192/sessions/sess-1/stop')
		expect(calls.map((c) => c.url)).toContain('http://localhost:8192/sessions/sess-1/resume')
	})

	it('resume does not attach when autoStream is off', async () => {
		const { fn, calls } = mockFetch([], { session_id: 'sess-1' })
		const s = session(fn, false)
		await s.create({ agent: { model: 'm' } })
		await s.stop()
		await s.resume()
		expect(s.status).toBe('running')
		expect(calls.some((c) => c.url.includes('/events'))).toBe(false)
	})

	it('loadHistory stores durable items', async () => {
		const history = {
			events: [
				{ kind: 'message', seq: 1, role: 'user', content: 'Hello' },
				{ kind: 'event', seq: 1, type: 'answer', payload: { text: 'Hi' }, ts: 't' },
			],
		}
		const { fn, calls } = mockFetch([], { session_id: 'sess-1' }, history)
		const s = session(fn, false)
		await s.create({ agent: { model: 'm' } })
		await s.loadHistory()

		expect(s.history).toHaveLength(2)
		expect(calls[1].url).toContain('/sessions/sess-1/history?after_seq=0')
	})

	it('loadHistory advances the cursor so attach does not replay it', async () => {
		const history = {
			events: [
				{ kind: 'message', seq: 1, role: 'user', content: 'Hello' },
				{ kind: 'event', seq: 7, type: 'answer', payload: { text: 'Hi' }, ts: 't' },
			],
		}
		const { fn, calls } = mockFetch([DONE(8)], { session_id: 'sess-1' }, history)
		const s = session(fn, false)
		await s.create({ agent: { model: 'm' } })
		await s.loadHistory()
		expect(s.lastSeq).toBe(7)

		await s.attach('sess-1')
		await s.attached
		const eventsCall = calls.find((c) => c.url.includes('/events'))
		expect(eventsCall?.url).toContain('after_seq=7')
	})

	it('loadHistory never moves the cursor backwards', async () => {
		const history = { events: [{ kind: 'event', seq: 2, type: 'answer', payload: {}, ts: 't' }] }
		const { fn } = mockFetch([ANSWER('x', 9), DONE(10)], { session_id: 'sess-1' }, history)
		const s = session(fn)
		await s.create({ agent: { model: 'm' } })
		await s.attached
		expect(s.lastSeq).toBe(10)

		await s.loadHistory()
		expect(s.lastSeq).toBe(10)
	})

	it('loadHistory ignores message seqs (independent space from events)', async () => {
		// messages.seq and events.seq are independent (§6): a message seq of 50
		// must not push the event cursor past the durable event seq of 3.
		const history = {
			events: [
				{ kind: 'message', seq: 50, role: 'user', content: 'Hello' },
				{ kind: 'event', seq: 3, type: 'answer', payload: { text: 'Hi' }, ts: 't' },
			],
		}
		const { fn, calls } = mockFetch([DONE(4)], { session_id: 'sess-1' }, history)
		const s = session(fn, false)
		await s.create({ agent: { model: 'm' } })
		await s.loadHistory()
		expect(s.lastSeq).toBe(3)

		await s.attach('sess-1')
		await s.attached
		const eventsCall = calls.find((c) => c.url.includes('/events'))
		expect(eventsCall?.url).toContain('after_seq=3')
	})
})

describe('event log bound', () => {
	it('keeps durable events and trims the oldest deltas', async () => {
		const frames = [DELTA('a', 1), DELTA('b', 2), DELTA('c', 3), ANSWER('abc', 4), DONE(5)]
		const { fn } = mockFetch(frames, { session_id: 'sess-1' })
		const s = session(fn, true, 3)
		await s.create({ agent: { model: 'm' } })
		await s.attached

		// 5 events arrived, cap is 3 → the 2 oldest deltas were dropped.
		expect(s.events).toHaveLength(3)
		expect(s.events.map((e) => e.type)).toEqual(['answer_delta', 'answer', 'done'])
		// The durable record is intact and the draft is unaffected.
		expect(s.text).toBe('abc')
		expect(s.lastSeq).toBe(5)
	})

	it('eventLogLimit 0 disables the log but keeps the reducer working', async () => {
		const { fn } = mockFetch([DELTA('a', 1), ANSWER('a', 2), DONE(3)], { session_id: 'sess-1' })
		const s = session(fn, true, 0)
		await s.create({ agent: { model: 'm' } })
		await s.attached

		expect(s.events).toEqual([])
		expect(s.text).toBe('a')
		expect(s.lastSeq).toBe(3)
	})
})

describe('isStreaming', () => {
	it('tracks the connection, not the agent status', async () => {
		// A stream that stays open until aborted.
		const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			if (String(input).includes('/events')) {
				const body = new ReadableStream<Uint8Array>({
					start(controller) {
						init?.signal?.addEventListener('abort', () => controller.close())
					},
				})
				return new Response(body, { status: 200 })
			}
			return jsonResponse({ session_id: 'sess-1' })
		}) as unknown as FetchFn
		const s = session(fn)
		expect(s.isStreaming).toBe(false)

		await s.create({ agent: { model: 'm' } })
		expect(s.isStreaming).toBe(true)

		// stop() pauses the agent but the SSE connection stays open.
		await s.stop()
		expect(s.status).toBe('paused')
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
			if (String(input).includes('/events')) {
				const body = new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(encoder.encode(DELTA('a', 1)))
						init?.signal?.addEventListener('abort', () => controller.close())
					},
				})
				return new Response(body, { status: 200 })
			}
			return jsonResponse({ session_id: 'sess-1' })
		}) as unknown as FetchFn
		const s = session(fn)
		await s.create({ agent: { model: 'm' } })
		await waitFor(() => s.text === 'a')
		expect(s.text).toBe('a')

		s.dispose()
		await s.attached
		expect(s.status).not.toBe('error')
		expect(s.error).toBeNull()
	})

	it('reset clears every field', async () => {
		const { fn } = mockFetch([ANSWER('hi', 1), DONE(2)], { session_id: 'sess-1' })
		const s = session(fn)
		await s.create({ agent: { model: 'm' } })
		await s.attached

		s.reset()
		expect(s.id).toBeNull()
		expect(s.status).toBe('idle')
		expect(s.text).toBe('')
		expect(s.events).toEqual([])
		expect(s.history).toEqual([])
		expect(s.error).toBeNull()
	})
})

describe('token refresh', () => {
	/** A fetch that 401s until the token matches `good`, then succeeds. */
	function authFetch(good: string) {
		const calls: { url: string; auth: string | null }[] = []
		const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input)
			const auth = new Headers(init?.headers).get('authorization')
			calls.push({ url, auth })
			if (auth !== `Bearer ${good}`) return jsonResponse({ detail: 'token expired' }, 401)
			if (url.includes('/events')) return new Response(sseBody([ANSWER('hi', 1), DONE(2)]))
			if (url.includes('/history')) return jsonResponse({ events: [] })
			return jsonResponse({ ok: true })
		})
		return { fn: fn as unknown as FetchFn, calls }
	}

	it('re-mints on 401 and retries the request once', async () => {
		const { fn, calls } = authFetch('fresh')
		const refresh = vi.fn(async () => 'fresh')
		const s = new ButlerSession({
			client: new AlfredClient({ fetchFn: fn, authToken: 'stale' }),
			autoStream: false,
			refreshToken: refresh,
		})
		s.id = 's1'
		await s.send('hello')

		expect(refresh).toHaveBeenCalledTimes(1)
		expect(calls.map((c) => c.auth)).toEqual(['Bearer stale', 'Bearer fresh'])
	})

	it('installs the refreshed token on the client for later requests', async () => {
		const { fn, calls } = authFetch('fresh')
		const s = new ButlerSession({
			client: new AlfredClient({ fetchFn: fn, authToken: 'stale' }),
			autoStream: false,
			refreshToken: async () => 'fresh',
		})
		s.id = 's1'
		await s.send('one')
		await s.send('two')

		// Second send starts with the refreshed token — no second 401.
		expect(calls.map((c) => c.auth)).toEqual(['Bearer stale', 'Bearer fresh', 'Bearer fresh'])
	})

	it('refreshes the SSE stream too', async () => {
		const { fn, calls } = authFetch('fresh')
		const refresh = vi.fn(async () => 'fresh')
		const s = new ButlerSession({
			client: new AlfredClient({ fetchFn: fn, authToken: 'stale' }),
			refreshToken: refresh,
		})
		await s.attach('s1')
		await s.attached

		expect(refresh).toHaveBeenCalledTimes(1)
		expect(s.text).toBe('hi')
		expect(s.status).toBe('done')
		expect(calls[0].auth).toBe('Bearer stale')
		expect(calls[1].auth).toBe('Bearer fresh')
	})

	it('propagates the 401 when no refreshToken is configured', async () => {
		const { fn } = authFetch('fresh')
		const s = new ButlerSession({
			client: new AlfredClient({ fetchFn: fn, authToken: 'stale' }),
			autoStream: false,
		})
		s.id = 's1'
		await expect(s.send('hello')).rejects.toMatchObject({ status: 401 })
	})

	it('does not retry a second time when the refreshed token is also rejected', async () => {
		const { fn, calls } = authFetch('never')
		const refresh = vi.fn(async () => 'still-bad')
		const s = new ButlerSession({
			client: new AlfredClient({ fetchFn: fn, authToken: 'stale' }),
			autoStream: false,
			refreshToken: refresh,
		})
		s.id = 's1'
		await expect(s.send('hello')).rejects.toMatchObject({ status: 401 })
		expect(refresh).toHaveBeenCalledTimes(1)
		expect(calls).toHaveLength(2)
	})

	it('does not refresh on a non-401 failure', async () => {
		const { fn } = mockFetch([], { detail: 'boom' })
		const refresh = vi.fn(async () => 'fresh')
		const s = new ButlerSession({
			client: new AlfredClient({ fetchFn: fn, authToken: 'tok' }),
			autoStream: false,
			refreshToken: refresh,
		})
		s.id = 's1'
		await s.send('hello')
		expect(refresh).not.toHaveBeenCalled()
	})

	it('installs a refreshed credential (token + URL) on the client', async () => {
		const calls: { url: string; auth: string | null }[] = []
		const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input)
			const auth = new Headers(init?.headers).get('authorization')
			calls.push({ url, auth })
			if (url === 'http://old:8192/sessions/s1/queue' && auth === 'Bearer stale') {
				return jsonResponse({ detail: 'token expired' }, 401)
			}
			return jsonResponse({ ok: true })
		}) as unknown as FetchFn
		const s = new ButlerSession({
			client: new AlfredClient({ fetchFn: fn, baseUrl: 'http://old:8192', authToken: 'stale' }),
			autoStream: false,
			refreshToken: async () => ({ token: 'fresh', base_url: 'https://alfred.example:8192' }),
		})
		s.id = 's1'
		await s.send('hello')

		expect(calls).toHaveLength(2)
		expect(calls[1].url).toBe('https://alfred.example:8192/sessions/s1/queue')
		expect(calls[1].auth).toBe('Bearer fresh')
	})
})
