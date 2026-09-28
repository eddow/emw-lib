import { describe, expect, it, vi } from 'vitest'
import { AlfredClient } from './client.js'
import { type AgentTool, createToolHandler, DEFAULT_TOOL_TIMEOUT_MS, toToolset } from './tools.js'
import type { FetchFn } from './types.js'

// ---------------------------------------------------------------------------
// A mocked transport: records every call, answers JSON.
// ---------------------------------------------------------------------------

function mockFetch(json: unknown = { ok: true }) {
	const calls: { url: string; init?: RequestInit }[] = []
	const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		calls.push({ url: String(input), init })
		return new Response(JSON.stringify(json), {
			status: 200,
			headers: { 'content-type': 'application/json' },
		})
	})
	return { fn: fn as unknown as FetchFn, calls }
}

/** A webhook request carrying a tool call. */
function toolRequest(body: unknown, headers: Record<string, string> = {}): Request {
	return new Request('https://emw.example/webhooks/alfred', {
		method: 'POST',
		headers: { 'content-type': 'application/json', ...headers },
		body: typeof body === 'string' ? body : JSON.stringify(body),
	})
}

const CALL = {
	session_id: 'sess-1',
	tool_call_id: 'call_1',
	name: 'search_contacts',
	arguments: { q: 'acme' },
}

/** A tool that records its input/ctx and returns a fixed value. */
function echoTool(overrides: Partial<AgentTool> = {}): AgentTool {
	return {
		name: 'search_contacts',
		description: 'Search contacts',
		parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
		execute: async (input) => ({ hits: [input] }),
		...overrides,
	}
}

/** Collect the work handed to `waitUntil` so tests can await it. */
function collector() {
	const pending: Promise<unknown>[] = []
	return {
		waitUntil: (work: Promise<unknown>) => {
			pending.push(work)
		},
		settle: () => Promise.all(pending),
	}
}

// ---------------------------------------------------------------------------

describe('toToolset', () => {
	it('emits every tool as a callback pointing at the webhook', () => {
		const toolset = toToolset([echoTool()], 'https://emw.example/webhooks/alfred', {
			max_iterations: 5,
		})
		expect(toolset.tools).toHaveLength(1)
		expect(toolset.tools?.[0]).toEqual({
			name: 'search_contacts',
			description: 'Search contacts',
			parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
			execution: {
				type: 'callback',
				url: 'https://emw.example/webhooks/alfred',
				timeout_ms: DEFAULT_TOOL_TIMEOUT_MS,
			},
		})
		expect(toolset.policy).toEqual({ max_iterations: 5 })
	})

	it('never emits an http execution (emw cannot hold a connection)', () => {
		const toolset = toToolset([echoTool(), echoTool({ name: 'other' })], 'https://x/y')
		for (const tool of toolset.tools ?? []) {
			expect(tool.execution?.type).toBe('callback')
		}
	})

	it('honours a custom timeout', () => {
		const toolset = toToolset([echoTool()], 'https://x/y', undefined, 3000)
		expect(toolset.tools?.[0].execution?.timeout_ms).toBe(3000)
	})
})

describe('createToolHandler — request handling', () => {
	it('rejects a bad secret with 401 before any work', async () => {
		const { fn, calls } = mockFetch()
		const { waitUntil, settle } = collector()
		const handler = createToolHandler({
			tools: [echoTool()],
			client: new AlfredClient({ fetchFn: fn }),
			authorize: (req) => req.headers.get('x-alfred-secret') === 's3cret',
			waitUntil,
		})

		const res = await handler(toolRequest(CALL, { 'x-alfred-secret': 'wrong' }))
		expect(res.status).toBe(401)
		await settle()
		expect(calls).toHaveLength(0)
	})

	it('accepts the right secret', async () => {
		const { fn } = mockFetch()
		const { waitUntil, settle } = collector()
		const handler = createToolHandler({
			tools: [echoTool()],
			client: new AlfredClient({ fetchFn: fn }),
			authorize: (req) => req.headers.get('x-alfred-secret') === 's3cret',
			waitUntil,
		})
		const res = await handler(toolRequest(CALL, { 'x-alfred-secret': 's3cret' }))
		expect(res.status).toBe(202)
		await settle()
	})

	it('rejects malformed JSON and missing fields with 400', async () => {
		const { fn } = mockFetch()
		const handler = createToolHandler({
			tools: [echoTool()],
			client: new AlfredClient({ fetchFn: fn }),
		})

		expect((await handler(toolRequest('not json{'))).status).toBe(400)
		expect((await handler(toolRequest({ session_id: 's', tool_call_id: 'c' }))).status).toBe(400)
		expect((await handler(toolRequest({ ...CALL, tool_call_id: '' }))).status).toBe(400)
		expect((await handler(toolRequest({ ...CALL, session_id: '' }))).status).toBe(400)
	})

	it('answers 202 without waiting for the work to finish', async () => {
		const { fn, calls } = mockFetch()
		// A tool that blocks until the test releases it.
		let release!: () => void
		const gate = new Promise<void>((resolve) => {
			release = resolve
		})
		const tool = echoTool({
			execute: async () => {
				await gate
				return { ok: true }
			},
		})
		const { waitUntil, settle } = collector()
		const handler = createToolHandler({
			tools: [tool],
			client: new AlfredClient({ fetchFn: fn }),
			waitUntil,
		})

		const res = await handler(toolRequest(CALL))
		// The response came back while the tool is still blocked: no PUT yet.
		expect(res.status).toBe(202)
		expect(calls).toHaveLength(0)

		release()
		await settle()
		expect(calls).toHaveLength(1)
	})
})

describe('createToolHandler — execution', () => {
	it('executes the tool and PUTs the result to /tool-callback', async () => {
		const { fn, calls } = mockFetch()
		const { waitUntil, settle } = collector()
		const handler = createToolHandler({
			tools: [echoTool()],
			client: new AlfredClient({ fetchFn: fn }),
			waitUntil,
		})

		await handler(toolRequest(CALL))
		await settle()

		expect(calls).toHaveLength(1)
		expect(calls[0].url).toBe('http://localhost:8192/sessions/sess-1/tool-callback')
		expect(calls[0].init?.method).toBe('POST')
		expect(JSON.parse(String(calls[0].init?.body))).toEqual({
			tool_call_id: 'call_1',
			result: { hits: [{ q: 'acme' }] },
		})
	})

	it('passes the resolved scope and call identity to execute', async () => {
		const { fn } = mockFetch()
		const { waitUntil, settle } = collector()
		let seen: unknown
		const tool = echoTool({
			execute: async (input, ctx) => {
				seen = {
					input,
					sessionId: ctx.sessionId,
					toolCallId: ctx.toolCallId,
					name: ctx.name,
					scope: ctx.scope,
				}
				return null
			},
		})
		const handler = createToolHandler({
			tools: [tool],
			client: new AlfredClient({ fetchFn: fn }),
			resolveScope: async (sid) => ({ chatId: `chat-for-${sid}`, entityId: 'ent-1' }),
			waitUntil,
		})

		await handler(toolRequest(CALL))
		await settle()

		expect(seen).toEqual({
			input: { q: 'acme' },
			sessionId: 'sess-1',
			toolCallId: 'call_1',
			name: 'search_contacts',
			scope: { chatId: 'chat-for-sess-1', entityId: 'ent-1' },
		})
	})

	it('defaults arguments to {} when omitted', async () => {
		const { fn } = mockFetch()
		const { waitUntil, settle } = collector()
		let seen: unknown
		const tool = echoTool({
			execute: async (input) => {
				seen = input
				return null
			},
		})
		const handler = createToolHandler({
			tools: [tool],
			client: new AlfredClient({ fetchFn: fn }),
			waitUntil,
		})

		await handler(toolRequest({ session_id: 's', tool_call_id: 'c', name: 'search_contacts' }))
		await settle()
		expect(seen).toEqual({})
	})

	it('returns an unknown tool as { error } with 202, not a 404', async () => {
		const { fn, calls } = mockFetch()
		const { waitUntil, settle } = collector()
		const handler = createToolHandler({
			tools: [echoTool()],
			client: new AlfredClient({ fetchFn: fn }),
			waitUntil,
		})

		const res = await handler(toolRequest({ ...CALL, name: 'nope' }))
		expect(res.status).toBe(202)
		await settle()

		expect(JSON.parse(String(calls[0].init?.body))).toEqual({
			tool_call_id: 'call_1',
			error: 'unknown tool: nope',
		})
	})

	it('returns a throwing tool as { error }, never a 5xx', async () => {
		const { fn, calls } = mockFetch()
		const { waitUntil, settle } = collector()
		const tool = echoTool({
			execute: async () => {
				throw new Error('db exploded')
			},
		})
		const handler = createToolHandler({
			tools: [tool],
			client: new AlfredClient({ fetchFn: fn }),
			waitUntil,
		})

		const res = await handler(toolRequest(CALL))
		expect(res.status).toBe(202)
		await settle()

		expect(JSON.parse(String(calls[0].init?.body))).toEqual({
			tool_call_id: 'call_1',
			error: 'db exploded',
		})
	})

	it('aborts a tool that exceeds the timeout and reports it as an error', async () => {
		const { fn, calls } = mockFetch()
		const { waitUntil, settle } = collector()
		const tool = echoTool({
			execute: (_input, ctx) =>
				new Promise((_resolve, reject) => {
					ctx.signal.addEventListener('abort', () => reject(new Error('aborted')))
				}),
		})
		const handler = createToolHandler({
			tools: [tool],
			client: new AlfredClient({ fetchFn: fn }),
			waitUntil,
			timeoutMs: 5,
		})

		await handler(toolRequest(CALL))
		await settle()

		expect(JSON.parse(String(calls[0].init?.body))).toEqual({
			tool_call_id: 'call_1',
			error: 'aborted',
		})
	})

	it('swallows a failing callback PUT (Alfred times the call out)', async () => {
		const fn = vi.fn(async () => {
			throw new TypeError('fetch failed')
		}) as unknown as FetchFn
		const { waitUntil, settle } = collector()
		const handler = createToolHandler({
			tools: [echoTool()],
			client: new AlfredClient({ fetchFn: fn }),
			waitUntil,
		})

		await handler(toolRequest(CALL))
		await expect(settle()).resolves.toBeDefined()
	})
})

describe('createToolHandler — dedupe', () => {
	it('treats a repeated tool_call_id as a no-op', async () => {
		const { fn, calls } = mockFetch()
		const { waitUntil, settle } = collector()
		let runs = 0
		const tool = echoTool({
			execute: async () => {
				runs++
				return { ok: true }
			},
		})
		const handler = createToolHandler({
			tools: [tool],
			client: new AlfredClient({ fetchFn: fn }),
			waitUntil,
		})

		const first = await handler(toolRequest(CALL))
		const second = await handler(toolRequest(CALL))
		await settle()

		expect(first.status).toBe(202)
		expect(second.status).toBe(200)
		expect(await second.json()).toEqual({ ok: true, deduped: true })
		expect(runs).toBe(1)
		expect(calls).toHaveLength(1)
	})

	it('uses an injected claim store when provided', async () => {
		const { fn } = mockFetch()
		const { waitUntil, settle } = collector()
		const claimed = new Set<string>()
		const handler = createToolHandler({
			tools: [echoTool()],
			client: new AlfredClient({ fetchFn: fn }),
			claim: async (id) => {
				if (claimed.has(id)) return false
				claimed.add(id)
				return true
			},
			waitUntil,
		})

		expect((await handler(toolRequest(CALL))).status).toBe(202)
		expect((await handler(toolRequest(CALL))).status).toBe(200)
		await settle()
		expect(claimed.has('call_1')).toBe(true)
	})

	it('allows distinct tool_call_ids through', async () => {
		const { fn, calls } = mockFetch()
		const { waitUntil, settle } = collector()
		const handler = createToolHandler({
			tools: [echoTool()],
			client: new AlfredClient({ fetchFn: fn }),
			waitUntil,
		})

		await handler(toolRequest({ ...CALL, tool_call_id: 'call_1' }))
		await handler(toolRequest({ ...CALL, tool_call_id: 'call_2' }))
		await settle()
		expect(calls).toHaveLength(2)
	})
})
