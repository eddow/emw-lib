import { describe, expect, it } from 'vitest'
import { checkWebhookSecret, createWebhookHandler } from './server.js'
import type { AgentTool } from './tools.js'

function echoTool(): AgentTool {
	return {
		name: 'search_contacts',
		description: 'Search contacts',
		parameters: { type: 'object', properties: { q: { type: 'string' } } },
		execute: async (input) => ({ hits: [input] }),
	}
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
	generation_id: 'gen_1',
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
	it('executes inline and returns { result } with the secret verified', async () => {
		const handler = createWebhookHandler({
			tools: [echoTool()],
			webhookSecret: 's3cret',
		})

		const res = await handler(toolRequest(CALL, { 'x-alfred-secret': 's3cret' }))
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ result: { hits: [{ q: 'acme' }] } })
	})

	it('rejects a bad secret with 401 before any work', async () => {
		let runs = 0
		const handler = createWebhookHandler({
			tools: [
				{
					...echoTool(),
					execute: async () => {
						runs++
						return { ok: true }
					},
				},
			],
			webhookSecret: 's3cret',
		})
		const res = await handler(toolRequest(CALL, { 'x-alfred-secret': 'wrong' }))
		expect(res.status).toBe(401)
		expect(runs).toBe(0)
	})

	it('passes generation_id to scope resolution', async () => {
		let seenScope: unknown
		const handler = createWebhookHandler({
			tools: [echoTool()],
			webhookSecret: 's3cret',
			resolveScope: async (sid) => {
				seenScope = sid
				return { chatId: 'c1' }
			},
		})
		const res = await handler(toolRequest(CALL, { 'x-alfred-secret': 's3cret' }))
		expect(res.status).toBe(200)
		expect(seenScope).toBe('sess-1')
	})

	it('unused AlfredClient import stays tree-shaken — handler needs no client', async () => {
		// The handler no longer PUTs back: no client, no waitUntil, no claim.
		const handler = createWebhookHandler({ tools: [echoTool()] })
		const res = await handler(toolRequest(CALL))
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ result: { hits: [{ q: 'acme' }] } })
	})
})
