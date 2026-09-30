import { describe, expect, it } from 'vitest'
import {
	type AgentTool,
	askHumanTool,
	type BuiltinToolDef,
	createToolHandler,
	DEFAULT_TOOL_TIMEOUT_MS,
	toHumanToolset,
	toMixedToolset,
	toToolset,
} from './tools.js'

// ---------------------------------------------------------------------------
// A mocked transport is no longer needed: the handler answers inline.
// ---------------------------------------------------------------------------

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
	generation_id: 'gen_1',
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

// ---------------------------------------------------------------------------

describe('toToolset', () => {
	it('emits every tool as a URL-free callback (generation owns the webhook URL)', () => {
		const toolset = toToolset([echoTool()], {
			max_iterations: 5,
		})
		expect(toolset.tools).toHaveLength(1)
		expect(toolset.tools?.[0]).toEqual({
			name: 'search_contacts',
			description: 'Search contacts',
			parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
			execution: {
				type: 'callback',
				timeout_ms: DEFAULT_TOOL_TIMEOUT_MS,
			},
		})
		expect(toolset.policy).toEqual({ max_iterations: 5 })
	})

	it('never emits an http execution or a url', () => {
		const toolset = toToolset([echoTool(), echoTool({ name: 'other' })])
		for (const tool of toolset.tools ?? []) {
			expect(tool.execution?.type).toBe('callback')
			expect(tool.execution?.url).toBeUndefined()
		}
	})

	it('honours a custom timeout', () => {
		const toolset = toToolset([echoTool()], undefined, 3000)
		expect(toolset.tools?.[0].execution?.timeout_ms).toBe(3000)
	})
})

describe('createToolHandler — request handling', () => {
	it('rejects a bad secret with 401 before any work', async () => {
		let runs = 0
		const handler = createToolHandler({
			tools: [
				echoTool({
					execute: async () => {
						runs++
						return { ok: true }
					},
				}),
			],
			authorize: (req) => req.headers.get('x-alfred-secret') === 's3cret',
		})

		const res = await handler(toolRequest(CALL, { 'x-alfred-secret': 'wrong' }))
		expect(res.status).toBe(401)
		expect(runs).toBe(0)
	})

	it('accepts the right secret and answers inline', async () => {
		const handler = createToolHandler({
			tools: [echoTool()],
			authorize: (req) => req.headers.get('x-alfred-secret') === 's3cret',
		})
		const res = await handler(toolRequest(CALL, { 'x-alfred-secret': 's3cret' }))
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ result: { hits: [{ q: 'acme' }] } })
	})

	it('rejects malformed JSON and missing fields with 400', async () => {
		const handler = createToolHandler({
			tools: [echoTool()],
		})

		expect((await handler(toolRequest('not json{'))).status).toBe(400)
		expect((await handler(toolRequest({ session_id: 's', tool_call_id: 'c' }))).status).toBe(400)
		expect((await handler(toolRequest({ ...CALL, tool_call_id: '' }))).status).toBe(400)
		expect((await handler(toolRequest({ ...CALL, session_id: '' }))).status).toBe(400)
	})
})

describe('createToolHandler — execution', () => {
	it('executes the tool and returns { result } inline', async () => {
		const handler = createToolHandler({
			tools: [echoTool()],
		})

		const res = await handler(toolRequest(CALL))
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ result: { hits: [{ q: 'acme' }] } })
	})

	it('passes generation_id + resolved scope + call identity to execute', async () => {
		let seen: unknown
		const tool = echoTool({
			execute: async (input, ctx) => {
				seen = {
					input,
					sessionId: ctx.sessionId,
					generationId: ctx.generationId,
					toolCallId: ctx.toolCallId,
					name: ctx.name,
					scope: ctx.scope,
				}
				return null
			},
		})
		const handler = createToolHandler({
			tools: [tool],
			resolveScope: async (sid) => ({ chatId: `chat-for-${sid}`, entityId: 'ent-1' }),
		})

		await handler(toolRequest(CALL))

		expect(seen).toEqual({
			input: { q: 'acme' },
			sessionId: 'sess-1',
			generationId: 'gen_1',
			toolCallId: 'call_1',
			name: 'search_contacts',
			scope: { chatId: 'chat-for-sess-1', entityId: 'ent-1' },
		})
	})

	it('defaults arguments to {} when omitted', async () => {
		let seen: unknown
		const tool = echoTool({
			execute: async (input) => {
				seen = input
				return null
			},
		})
		const handler = createToolHandler({
			tools: [tool],
		})

		const res = await handler(
			toolRequest({
				session_id: 's',
				generation_id: 'g',
				tool_call_id: 'c',
				name: 'search_contacts',
			})
		)
		expect(res.status).toBe(200)
		expect(seen).toEqual({})
	})

	it('returns an unknown tool as { error } with 200, not a 404', async () => {
		const handler = createToolHandler({
			tools: [echoTool()],
		})

		const res = await handler(toolRequest({ ...CALL, name: 'nope' }))
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ error: 'unknown tool: nope' })
	})

	it('returns a throwing tool as { error }, never a 5xx', async () => {
		const tool = echoTool({
			execute: async () => {
				throw new Error('db exploded')
			},
		})
		const handler = createToolHandler({
			tools: [tool],
		})

		const res = await handler(toolRequest(CALL))
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ error: 'db exploded' })
	})

	it('aborts a tool that exceeds the timeout and reports it as an error', async () => {
		const tool = echoTool({
			execute: (_input, ctx) =>
				new Promise((_resolve, reject) => {
					ctx.signal.addEventListener('abort', () => reject(new Error('aborted')))
				}),
		})
		const handler = createToolHandler({
			tools: [tool],
			timeoutMs: 5,
		})

		const res = await handler(toolRequest(CALL))
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ error: 'aborted' })
	})
})

describe('toMixedToolset', () => {
	const builtin: BuiltinToolDef = {
		name: 'web_search',
		description: 'Keyword web search',
		parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
	}

	it('mixes hard-coded builtins with webhook-defined callbacks', () => {
		const toolset = toMixedToolset({
			callbackTools: [echoTool()],
			builtinDefs: [builtin],
			policy: { max_iterations: 5 },
		})
		expect(toolset.tools).toHaveLength(2)
		expect(toolset.tools?.[0]).toEqual({
			...builtin,
			execution: { type: 'builtin' },
		})
		expect(toolset.tools?.[1].execution?.type).toBe('callback')
		expect(toolset.policy).toEqual({ max_iterations: 5 })
	})

	it('lets a callback shadow a builtin of the same name', () => {
		const toolset = toMixedToolset({
			callbackTools: [echoTool({ name: 'web_search' })],
			builtinDefs: [builtin],
		})
		expect(toolset.tools).toHaveLength(1)
		expect(toolset.tools?.[0].execution?.type).toBe('callback')
	})

	it('dedupes live descriptors against the static mirror by name', () => {
		const live = { ...builtin, description: 'stale copy from an old Alfred' }
		const toolset = toMixedToolset({ builtinDefs: [builtin, live] })
		expect(toolset.tools).toHaveLength(1)
		expect(toolset.tools?.[0].description).toBe('Keyword web search')
	})

	it('appends human tools after builtins/callbacks/prompts', () => {
		const toolset = toMixedToolset({
			callbackTools: [echoTool()],
			builtinDefs: [builtin],
			humanTools: [
				{
					name: 'pick_date',
					description: 'Pick a date',
					parameters: { type: 'object', properties: { label: { type: 'string' } } },
				},
			],
		})
		expect(toolset.tools?.map((t) => t.execution?.type)).toEqual(['builtin', 'callback', 'human'])
	})
})

describe('toHumanToolset / askHumanTool', () => {
	it('emits URL-free human descriptors with timeout defaults', () => {
		const defs = toHumanToolset([
			{
				name: 'pick_date',
				description: 'Pick a date',
				parameters: {
					type: 'object',
					properties: { label: { type: 'string' } },
					required: ['label'],
				},
				default_value: { date: '2026-01-01' },
			},
		])
		expect(defs).toHaveLength(1)
		expect(defs[0]).toEqual({
			name: 'pick_date',
			description: 'Pick a date',
			parameters: {
				type: 'object',
				properties: { label: { type: 'string' } },
				required: ['label'],
			},
			execution: {
				type: 'human',
				timeout_s: 0,
				on_timeout: 'autopick',
				default_value: { date: '2026-01-01' },
			},
		})
		expect(defs[0].execution?.url).toBeUndefined()
	})

	it('askHumanTool is the multiple-choice convention with first-option default', () => {
		const def = askHumanTool()
		expect(def.name).toBe('ask_human')
		expect(def.execution?.type).toBe('human')
		expect(def.execution?.timeout_s).toBe(0)
		expect(def.execution?.on_timeout).toBe('autopick')
		const props = def.parameters?.properties as Record<string, unknown>
		expect(props).toHaveProperty('questions')
		expect(def.parameters?.required).toEqual(['questions'])
	})

	it('askHumanTool honours timeout overrides', () => {
		const def = askHumanTool({ timeout_s: 120, on_timeout: 'error' })
		expect(def.execution?.timeout_s).toBe(120)
		expect(def.execution?.on_timeout).toBe('error')
	})
})
