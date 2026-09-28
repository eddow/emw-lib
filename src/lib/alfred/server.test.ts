import { describe, expect, it, vi } from 'vitest'
import { AlfredClient } from './client.js'
import { checkWebhookSecret, createWebhookHandler } from './server.js'
import type { AgentTool } from './tools.js'
import type { FetchFn } from './types.js'

function echoTool(): AgentTool {
	return {
		name: 'search_contacts',
		description: 'Search contacts',
		parameters: { type: 'object', properties: { q: { type: 'string' } } },
		execute: async (input) => ({ hits: [input] }),
	}
}

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

function toolRequest(body: unknown, headers: Record<string, string> = {}): Request {
	return new Request('https://emw.example/webhooks/alfred', {
		method: 'POST',
		headers: { 'content-type': 'application/json', ...headers },
		body: JSON.stringify(body),
	})
}

const CALL = {
	session_id: 'sess-1',
	tool_call_id: 'call_1',
	name: 'search_contacts',
	arguments: { q: 'acme' },
}

describe('checkWebhookSecret', () => {
	it('skips the check when no secret is configured (local dev)', () => {
		expect(checkWebhookSecret(toolRequest(CALL), undefined)).toBe(true)
		expect(checkWebhookSecret(toolRequest(CALL), '')).toBe(true)
	})

	it('compares against X-Alfred-Secret when configured', () => {
		expect(checkWebhookSecret(toolRequest(CALL, { 'x-alfred-secret': 's3cret' }), 's3cret')).toBe(
			true
		)
		expect(checkWebhookSecret(toolRequest(CALL, { 'x-alfred-secret': 'wrong' }), 's3cret')).toBe(
			false
		)
		expect(checkWebhookSecret(toolRequest(CALL), 's3cret')).toBe(false)
	})
})

describe('createWebhookHandler', () => {
	it('answers 202 and PUTs the result back with the secret', async () => {
		const { fn, calls } = mockFetch()
		const pending: Promise<unknown>[] = []
		const handler = createWebhookHandler({
			tools: [echoTool()],
			client: new AlfredClient({ fetchFn: fn, webhookSecret: 's3cret' }),
			webhookSecret: 's3cret',
			waitUntil: (work) => void pending.push(work),
		})

		const res = await handler(toolRequest(CALL, { 'x-alfred-secret': 's3cret' }))
		expect(res.status).toBe(202)
		await Promise.all(pending)
		expect(calls).toHaveLength(1)
		expect(calls[0].url).toBe('http://localhost:8192/sessions/sess-1/tool-callback')
		expect(new Headers(calls[0].init?.headers).get('x-alfred-secret')).toBe('s3cret')
	})

	it('rejects a bad secret with 401 before any work', async () => {
		const { fn, calls } = mockFetch()
		const handler = createWebhookHandler({
			tools: [echoTool()],
			client: new AlfredClient({ fetchFn: fn }),
			webhookSecret: 's3cret',
		})
		const res = await handler(toolRequest(CALL, { 'x-alfred-secret': 'wrong' }))
		expect(res.status).toBe(401)
		expect(calls).toHaveLength(0)
	})

	it('builds its own client from baseUrl + secret when none is passed', async () => {
		const { fn } = mockFetch()
		const pending: Promise<unknown>[] = []
		// Swap the global fetch so the auto-built client records its PUT-back.
		const origFetch = globalThis.fetch
		globalThis.fetch = fn as unknown as typeof fetch
		try {
			const handler = createWebhookHandler({
				tools: [echoTool()],
				baseUrl: 'http://butler:8192',
				webhookSecret: 's3cret',
				waitUntil: (work) => void pending.push(work),
			})
			const res = await handler(toolRequest(CALL, { 'x-alfred-secret': 's3cret' }))
			expect(res.status).toBe(202)
			await Promise.all(pending)
		} finally {
			globalThis.fetch = origFetch
		}
		const put = (fn as unknown as { mock: { calls: [RequestInfo | URL, RequestInit?][] } }).mock
			.calls[0]
		expect(String(put[0])).toBe('http://butler:8192/sessions/sess-1/tool-callback')
		expect(new Headers(put[1]?.headers).get('x-alfred-secret')).toBe('s3cret')
	})
})
