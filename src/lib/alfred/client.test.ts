import { describe, expect, it, vi } from 'vitest'
import { AlfredClient, AlfredError } from './client.js'
import type { FetchFn } from './types.js'

// ---------------------------------------------------------------------------
// Fixtures: faithful copies of the wire shapes emitted by `butler/src/alfred`
// (FastAPI). Keys stay snake_case — the wire is the contract.
// ---------------------------------------------------------------------------

const SESSION_INFO = {
	id: 'abc123def456',
	status: 'running',
	runtime_status: 'running',
	agent: {
		model: 'anthropic/claude-sonnet-4',
		system_prompt: '',
		temperature: 0.2,
		max_tokens: 4096,
	},
	toolset: { tools: [], policy: { max_iterations: 20, tool_choice: 'auto' } },
	created_at: '2026-09-28T10:00:00Z',
}

const HISTORY_JSON = {
	events: [
		{ kind: 'message', seq: 1, role: 'user', content: 'Hello' },
		{
			kind: 'event',
			seq: 1,
			type: 'answer',
			payload: { text: 'Hi there', stream_id: 's1', delta_count: 3 },
			ts: '2026-09-28T10:00:01Z',
		},
	],
}

const POLL_JSON = {
	events: [
		{ type: 'answer_delta', stream_id: 's1', stream_seq: 1, text: 'Hel' },
		{ type: 'answer_delta', stream_id: 's1', stream_seq: 2, text: 'lo' },
	],
	next_seq: 5,
	timeout: false,
}

/** Build a real `Response` so the client's `ok`/`json`/`text`/`body` paths are exercised. */
function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	})
}

/** A fetch mock that records `[url, init]` and delegates to `handler`. */
function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
	const calls: { url: string; init?: RequestInit }[] = []
	const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input)
		calls.push({ url, init })
		return handler(url, init)
	})
	return { fn: fn as unknown as FetchFn, calls }
}

/** Encode SSE chunks into a `ReadableStream` body, split at arbitrary boundaries. */
function sseBody(chunks: string[]): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder()
	return new ReadableStream({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
			controller.close()
		},
	})
}

// ---------------------------------------------------------------------------

describe('createSession', () => {
	it('POSTs the agent/toolset/initial_prompt/metadata body and returns session_id', async () => {
		const { fn, calls } = mockFetch(() => jsonResponse({ session_id: 'abc123def456' }, 201))
		const client = new AlfredClient({ baseUrl: 'http://butler:8192/', fetchFn: fn })

		const out = await client.createSession({
			agent: { model: 'anthropic/claude-sonnet-4', system_prompt: 'be nice' },
			toolset: { tools: [{ name: 'search_docs', execution: { type: 'http', url: 'http://t/x' } }] },
			initial_prompt: 'Hello',
			metadata: { source: 'emw' },
		})

		expect(out.session_id).toBe('abc123def456')
		expect(calls).toHaveLength(1)
		// trailing slash on baseUrl is trimmed
		expect(calls[0].url).toBe('http://butler:8192/sessions')
		expect(calls[0].init?.method).toBe('POST')
		const body = JSON.parse(String(calls[0].init?.body))
		expect(body.agent.model).toBe('anthropic/claude-sonnet-4')
		expect(body.toolset.tools[0].name).toBe('search_docs')
		expect(body.initial_prompt).toBe('Hello')
		expect(body.metadata).toEqual({ source: 'emw' })
	})

	it('omits undefined optional keys instead of sending nulls', async () => {
		const { fn, calls } = mockFetch(() => jsonResponse({ session_id: 'x' }, 201))
		const client = new AlfredClient({ fetchFn: fn })
		await client.createSession({ agent: { model: 'm' } })
		const body = JSON.parse(String(calls[0].init?.body))
		expect(body).toEqual({ agent: { model: 'm' } })
		expect('toolset' in body).toBe(false)
		expect('initial_prompt' in body).toBe(false)
	})

	it('rejects a missing model before any fetch', async () => {
		const { fn, calls } = mockFetch(() => jsonResponse({}))
		const client = new AlfredClient({ fetchFn: fn })
		await expect(client.createSession({ agent: { model: '' } })).rejects.toBeInstanceOf(AlfredError)
		expect(calls).toHaveLength(0)
	})
})

describe('history / poll', () => {
	it('encodes after_seq and type on history', async () => {
		const { fn, calls } = mockFetch(() => jsonResponse(HISTORY_JSON))
		const client = new AlfredClient({ fetchFn: fn })
		const out = await client.history('sid 1', 7, 'answer')
		expect(out.events).toHaveLength(2)
		expect(calls[0].url).toBe(
			'http://localhost:8192/sessions/sid%201/history?after_seq=7&type=answer'
		)
	})

	it('encodes after_seq and timeout_s on poll', async () => {
		const { fn, calls } = mockFetch(() => jsonResponse(POLL_JSON))
		const client = new AlfredClient({ fetchFn: fn })
		const out = await client.poll('s1', 4, 25)
		expect(out.next_seq).toBe(5)
		expect(out.events[0].type).toBe('answer_delta')
		expect(calls[0].url).toBe('http://localhost:8192/sessions/s1/poll?after_seq=4&timeout_s=25')
	})

	it('clamps timeout_s to 0..60', async () => {
		const { fn, calls } = mockFetch(() => jsonResponse({ events: [], next_seq: 0, timeout: true }))
		const client = new AlfredClient({ fetchFn: fn })
		await client.poll('s1', 0, 999)
		expect(calls[0].url).toContain('timeout_s=60')
	})

	it('returns { timeout: true } without throwing', async () => {
		const { fn } = mockFetch(() => jsonResponse({ events: [], next_seq: 3, timeout: true }))
		const client = new AlfredClient({ fetchFn: fn })
		const out = await client.poll('s1', 3, 1)
		expect(out.timeout).toBe(true)
		expect(out.events).toEqual([])
	})
})

describe('events (SSE)', () => {
	it('parses multi-chunk SSE, skips comments and [DONE]', async () => {
		const { fn } = mockFetch(
			() =>
				new Response(
					sseBody([
						': heartbeat\n\n',
						'event: answer_delta\ndata: {"type":"answer_delta","stream_id":"s1","stream_seq":1,"text":"Hel"}\n\n',
						'event: answer_delta\ndata: {"type":"answer_delta","stream_id":"s1","stream_seq":2,"text":"lo"}\n\n',
						'event: answer\ndata: {"seq":3,"type":"answer","payload":{"text":"Hello"},"ts":"t"}\n\n',
						'data: [DONE]\n\n',
					]),
					{ status: 200, headers: { 'content-type': 'text/event-stream' } }
				)
		)
		const client = new AlfredClient({ fetchFn: fn })
		const seen: unknown[] = []
		for await (const evt of client.events('s1', 0)) seen.push(evt)

		expect(seen).toHaveLength(3)
		expect((seen[0] as { text: string }).text).toBe('Hel')
		expect((seen[2] as { seq: number }).seq).toBe(3)
	})

	it('handles a frame split across two network chunks', async () => {
		const { fn } = mockFetch(
			() =>
				new Response(
					sseBody([
						'event: answer_delta\ndata: {"type":"answer_delta","stream_id":"s1","stream_',
						'seq":1,"text":"Hi"}\n\n',
					]),
					{ status: 200 }
				)
		)
		const client = new AlfredClient({ fetchFn: fn })
		const seen: unknown[] = []
		for await (const evt of client.events('s1')) seen.push(evt)
		expect(seen).toHaveLength(1)
		expect((seen[0] as { text: string }).text).toBe('Hi')
	})

	it('throws AlfredError on a non-2xx before reading the body', async () => {
		const { fn } = mockFetch(() => jsonResponse({ detail: 'session not found: x' }, 404))
		const client = new AlfredClient({ fetchFn: fn })
		const iterate = async () => {
			for await (const _ of client.events('x')) void _
		}
		await expect(iterate()).rejects.toMatchObject({ code: 'http', status: 404 })
	})

	it('stops cleanly when the caller aborts', async () => {
		const controller = new AbortController()
		const { fn } = mockFetch(
			() =>
				new Response(
					sseBody([
						'event: answer_delta\ndata: {"type":"answer_delta","stream_id":"s1","stream_seq":1,"text":"a"}\n\n',
					]),
					{ status: 200 }
				)
		)
		const client = new AlfredClient({ fetchFn: fn })
		const seen: unknown[] = []
		for await (const evt of client.events('s1', 0, controller.signal)) {
			seen.push(evt)
			controller.abort()
		}
		expect(seen).toHaveLength(1)
	})
})

describe('pollLoop', () => {
	it('yields events, advances the durable cursor, and returns on timeout', async () => {
		let call = 0
		const { fn, calls } = mockFetch(() => {
			call += 1
			if (call === 1)
				return jsonResponse({
					events: [
						{ type: 'answer_delta', stream_id: 's1', stream_seq: 1, text: 'a' },
						{ seq: 4, type: 'answer', payload: { text: 'a' }, ts: 't' },
					],
					next_seq: 5,
					timeout: false,
				})
			return jsonResponse({ events: [], next_seq: 5, timeout: true })
		})
		const client = new AlfredClient({ fetchFn: fn })
		const seen: unknown[] = []
		for await (const evt of client.pollLoop('s1', { after_seq: 0, timeout_s: 1 })) seen.push(evt)

		expect(seen).toHaveLength(2)
		expect(calls).toHaveLength(2)
		// second poll resumes from the durable seq (4) + 1, not from the delta
		expect(calls[1].url).toContain('after_seq=5')
	})

	it('keeps the cursor on a pure-delta batch', async () => {
		let call = 0
		const { fn, calls } = mockFetch(() => {
			call += 1
			if (call === 1)
				return jsonResponse({
					events: [{ type: 'answer_delta', stream_id: 's1', stream_seq: 1, text: 'a' }],
					next_seq: 0,
					timeout: false,
				})
			return jsonResponse({ events: [], next_seq: 0, timeout: true })
		})
		const client = new AlfredClient({ fetchFn: fn })
		for await (const _ of client.pollLoop('s1', { after_seq: 2 })) void _
		expect(calls[1].url).toContain('after_seq=2')
	})
})

describe('control plane', () => {
	it('getSession returns the full detail shape', async () => {
		const { fn, calls } = mockFetch(() => jsonResponse(SESSION_INFO))
		const client = new AlfredClient({ fetchFn: fn })
		const one = await client.getSession('abc123def456')
		expect(one.agent.model).toBe('anthropic/claude-sonnet-4')
		expect(one.runtime_status).toBe('running')
		expect(calls.map((c) => c.url)).toEqual(['http://localhost:8192/sessions/abc123def456'])
	})

	it('listSessions returns summaries (no agent/toolset)', async () => {
		const summary = {
			id: 'abc123def456',
			status: 'running',
			model: 'anthropic/claude-sonnet-4',
			created_at: '2026-09-28T10:00:00Z',
			message_count: 2,
			event_count: 5,
		}
		const { fn, calls } = mockFetch(() => jsonResponse({ sessions: [summary] }))
		const client = new AlfredClient({ fetchFn: fn })
		const all = await client.listSessions()
		expect(all.sessions).toHaveLength(1)
		expect(all.sessions[0].model).toBe('anthropic/claude-sonnet-4')
		expect(all.sessions[0].message_count).toBe(2)
		expect(calls.map((c) => c.url)).toEqual(['http://localhost:8192/sessions'])
	})

	it('queue / steer / redirect hit distinct paths with { prompt }', async () => {
		const { fn, calls } = mockFetch(() => jsonResponse({ ok: true }))
		const client = new AlfredClient({ fetchFn: fn })
		await client.queue('s1', 'q')
		await client.steer('s1', 's')
		await client.redirect('s1', 'r')

		expect(calls.map((c) => c.url)).toEqual([
			'http://localhost:8192/sessions/s1/queue',
			'http://localhost:8192/sessions/s1/steer',
			'http://localhost:8192/sessions/s1/redirect',
		])
		for (const c of calls)
			expect(JSON.parse(String(c.init?.body))).toEqual({ prompt: expect.any(String) })
	})

	it('stop / resume / delete / backup / health use the documented verbs', async () => {
		const { fn, calls } = mockFetch((url) =>
			url.endsWith('/backup')
				? jsonResponse({ ok: true, path: '/data/backup.db' })
				: jsonResponse({ ok: true, status: 'paused' })
		)
		const client = new AlfredClient({ fetchFn: fn })
		await client.stop('s1')
		await client.resume('s1')
		await client.deleteSession('s1')
		const backup = await client.backup('s1')
		await client.health()

		expect(backup.path).toBe('/data/backup.db')
		expect(calls.map((c) => `${c.init?.method} ${c.url}`)).toEqual([
			'POST http://localhost:8192/sessions/s1/stop',
			'POST http://localhost:8192/sessions/s1/resume',
			'DELETE http://localhost:8192/sessions/s1',
			'POST http://localhost:8192/sessions/s1/backup',
			'GET http://localhost:8192/health',
		])
	})

	it('toolCallback posts tool_call_id + result', async () => {
		const { fn, calls } = mockFetch(() => jsonResponse({ ok: true }))
		const client = new AlfredClient({ fetchFn: fn })
		await client.toolCallback('s1', { tool_call_id: 'call_1', result: { hits: 2 } })
		expect(calls[0].url).toBe('http://localhost:8192/sessions/s1/tool-callback')
		expect(JSON.parse(String(calls[0].init?.body))).toEqual({
			tool_call_id: 'call_1',
			result: { hits: 2 },
		})
	})

	it('guarded calls carry X-Alfred-Secret when a webhook secret is set', async () => {
		const { fn, calls } = mockFetch(() => jsonResponse({ ok: true, expired: 0 }))
		const client = new AlfredClient({ fetchFn: fn, webhookSecret: 's3cret' })
		await client.toolCallback('s1', { tool_call_id: 'call_1', result: {} })
		await client.expireCallbacks('s1')
		await client.createSession({ agent: { model: 'm' } })
		await client.getSession('s1')
		const headers = (init?: RequestInit) => new Headers(init?.headers)
		for (const c of calls) expect(headers(c.init).get('x-alfred-secret')).toBe('s3cret')
	})

	it('guarded calls omit X-Alfred-Secret when no secret is set (local dev)', async () => {
		const { fn, calls } = mockFetch(() => jsonResponse({ ok: true, expired: 0 }))
		const client = new AlfredClient({ fetchFn: fn })
		await client.toolCallback('s1', { tool_call_id: 'call_1', result: {} })
		expect(new Headers(calls[0].init?.headers).get('x-alfred-secret')).toBeNull()
	})

	it('setWebhookSecret replaces the secret for subsequent calls', async () => {
		const { fn, calls } = mockFetch(() => jsonResponse({ ok: true, expired: 0 }))
		const client = new AlfredClient({ fetchFn: fn, webhookSecret: 'old' })
		client.setWebhookSecret('new')
		await client.expireCallbacks('s1')
		expect(new Headers(calls[0].init?.headers).get('x-alfred-secret')).toBe('new')
		client.setWebhookSecret(undefined)
		await client.expireCallbacks('s1')
		expect(new Headers(calls[1].init?.headers).get('x-alfred-secret')).toBeNull()
	})

	it('expireCallbacks posts to the expire endpoint and returns the count', async () => {
		const { fn, calls } = mockFetch(() => jsonResponse({ ok: true, expired: 3 }))
		const client = new AlfredClient({ fetchFn: fn })
		const out = await client.expireCallbacks('s1')
		expect(out.expired).toBe(3)
		expect(calls[0].url).toBe('http://localhost:8192/sessions/s1/tool-callback/expire')
		expect(calls[0].init?.method).toBe('POST')
	})

	it('mintToken POSTs to /token and returns token + expires_at', async () => {
		const { fn, calls } = mockFetch(() =>
			jsonResponse({ token: 'tok-abc', expires_at: '2026-09-28T11:00:00Z' })
		)
		const client = new AlfredClient({ fetchFn: fn })
		const out = await client.mintToken('s1')
		expect(out.token).toBe('tok-abc')
		expect(out.expires_at).toBe('2026-09-28T11:00:00Z')
		expect(calls[0].url).toBe('http://localhost:8192/sessions/s1/token')
		expect(calls[0].init?.method).toBe('POST')
	})

	it('mintToken rejects an empty sid before any fetch', async () => {
		const { fn, calls } = mockFetch(() => jsonResponse({}))
		const client = new AlfredClient({ fetchFn: fn })
		await expect(client.mintToken('')).rejects.toMatchObject({ code: 'validation' })
		expect(calls).toHaveLength(0)
	})
})

describe('auth token', () => {
	/** Read a header off a recorded call, case-insensitively. */
	function header(init: RequestInit | undefined, name: string): string | null {
		return new Headers(init?.headers).get(name)
	}

	it('sends no Authorization header when no token is configured', async () => {
		const { fn, calls } = mockFetch(() => jsonResponse({ ok: true }))
		const client = new AlfredClient({ fetchFn: fn })
		await client.health()
		expect(header(calls[0].init, 'authorization')).toBeNull()
	})

	it('sends Authorization: Bearer on every request when a token is set', async () => {
		const { fn, calls } = mockFetch(() => jsonResponse({ ok: true }))
		const client = new AlfredClient({ fetchFn: fn, authToken: 'tok-1' })
		await client.health()
		await client.getSession('s1')
		expect(header(calls[0].init, 'authorization')).toBe('Bearer tok-1')
		expect(header(calls[1].init, 'authorization')).toBe('Bearer tok-1')
	})

	it('carries the token on the SSE request too', async () => {
		const { fn, calls } = mockFetch(
			() =>
				new Response(sseBody(['event: answer\ndata: {"type":"answer","text":"hi"}\n\n']), {
					status: 200,
					headers: { 'content-type': 'text/event-stream' },
				})
		)
		const client = new AlfredClient({ fetchFn: fn, authToken: 'tok-sse', webhookSecret: 's3' })
		for await (const _ of client.events('s1')) break
		expect(header(calls[0].init, 'authorization')).toBe('Bearer tok-sse')
		expect(header(calls[0].init, 'accept')).toBe('text/event-stream')
		expect(header(calls[0].init, 'x-alfred-secret')).toBe('s3')
	})

	it('setAuthToken replaces the token for subsequent requests', async () => {
		const { fn, calls } = mockFetch(() => jsonResponse({ ok: true }))
		const client = new AlfredClient({ fetchFn: fn, authToken: 'old' })
		await client.health()
		client.setAuthToken('new')
		await client.health()
		expect(header(calls[0].init, 'authorization')).toBe('Bearer old')
		expect(header(calls[1].init, 'authorization')).toBe('Bearer new')
	})

	it('setAuthToken(undefined) clears the header', async () => {
		const { fn, calls } = mockFetch(() => jsonResponse({ ok: true }))
		const client = new AlfredClient({ fetchFn: fn, authToken: 'tok' })
		client.setAuthToken(undefined)
		await client.health()
		expect(header(calls[0].init, 'authorization')).toBeNull()
	})

	it('setCredential swaps token and base URL together', async () => {
		const { fn, calls } = mockFetch(() => jsonResponse({ ok: true }))
		const client = new AlfredClient({ fetchFn: fn, baseUrl: 'http://old:8192' })
		client.setCredential({ token: 'tok-1', base_url: 'https://alfred.example:8192/' })
		await client.health()
		expect(calls[0].url).toBe('https://alfred.example:8192/health')
		expect(header(calls[0].init, 'authorization')).toBe('Bearer tok-1')
	})

	it('setCredential keeps the URL when base_url is empty', async () => {
		const { fn, calls } = mockFetch(() => jsonResponse({ ok: true }))
		const client = new AlfredClient({ fetchFn: fn, baseUrl: 'http://old:8192' })
		client.setCredential({ token: 'tok-1', base_url: '' })
		await client.health()
		expect(calls[0].url).toBe('http://old:8192/health')
	})

	it('setCredential rejects a missing token before any fetch', async () => {
		const { fn, calls } = mockFetch(() => jsonResponse({}))
		const client = new AlfredClient({ fetchFn: fn })
		expect(() => client.setCredential({ token: '' })).toThrow()
		expect(calls).toHaveLength(0)
	})
})

describe('validation (throws before fetch)', () => {
	it('rejects empty sid, empty prompt and negative after_seq', async () => {
		const { fn, calls } = mockFetch(() => jsonResponse({}))
		const client = new AlfredClient({ fetchFn: fn })

		await expect(client.getSession('')).rejects.toMatchObject({ code: 'validation' })
		await expect(client.queue('s1', '')).rejects.toMatchObject({ code: 'validation' })
		await expect(client.queue('s1', 'x'.repeat(4001))).rejects.toMatchObject({ code: 'validation' })
		await expect(client.history('s1', -1)).rejects.toMatchObject({ code: 'validation' })
		await expect(client.poll('s1', 1.5)).rejects.toMatchObject({ code: 'validation' })
		expect(calls).toHaveLength(0)
	})
})

describe('error mapping', () => {
	it('maps a non-2xx JSON body to AlfredError with status + detail', async () => {
		const { fn } = mockFetch(() => jsonResponse({ detail: 'session not found: zz' }, 404))
		const client = new AlfredClient({ fetchFn: fn })
		await expect(client.getSession('zz')).rejects.toMatchObject({
			name: 'AlfredError',
			code: 'http',
			status: 404,
			message: 'session not found: zz',
		})
	})

	it('maps a transport failure to code network', async () => {
		const fn = vi.fn(async () => {
			throw new TypeError('fetch failed')
		}) as unknown as FetchFn
		const client = new AlfredClient({ fetchFn: fn })
		await expect(client.health()).rejects.toMatchObject({ code: 'network' })
	})

	it('maps a timeout to code timeout', async () => {
		const fn = vi.fn(
			(_url: RequestInfo | URL, init?: RequestInit) =>
				new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
				})
		) as unknown as FetchFn
		const client = new AlfredClient({ fetchFn: fn, defaultTimeoutMs: 5 })
		await expect(client.health()).rejects.toMatchObject({ code: 'timeout' })
	})

	it('extends the client timeout past the server hold on long polls', async () => {
		let observedSignal: AbortSignal | undefined
		const fn = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
			observedSignal = init?.signal ?? undefined
			return jsonResponse({ events: [], next_seq: 1, timeout: true })
		}) as unknown as FetchFn
		// defaultTimeoutMs 5ms would kill a 25s server hold without the extension.
		const client = new AlfredClient({ fetchFn: fn, defaultTimeoutMs: 5 })
		const out = await client.poll('s1', 0, 25)
		expect(out.timeout).toBe(true)
		expect(observedSignal).toBeDefined()
	})

	it('never applies the implicit timeout to the SSE stream', async () => {
		let observedSignal: AbortSignal | null | undefined
		const fn = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
			observedSignal = init?.signal ?? null
			return new Response(sseBody([]), { status: 200 })
		}) as unknown as FetchFn
		// A 5ms default must not abort the stream: no signal is attached at all.
		const client = new AlfredClient({ fetchFn: fn, defaultTimeoutMs: 5 })
		for await (const _ of client.events('s1')) void _
		expect(observedSignal).toBeNull()
	})
})
