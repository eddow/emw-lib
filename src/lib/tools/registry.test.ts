import { describe, expect, it, vi } from 'vitest'
import type { AgentTool } from '../alfred/tools.js'
import { JEV_TYPESAFE_URL } from '../jev/client.js'
import type { FetchFn } from '../serps/types.js'
import { parseBodaccRecord } from './bodacc.js'
import { jevDecideTool, jevMatchTool } from './jev.js'
import { createLibTool, LIB_TOOL_DEFAULTS, LIB_TOOL_NAMES, resolveLibTools } from './registry.js'
import { adapterFor, SERP_SOURCES } from './serps.js'

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
	const calls: { url: string; init?: RequestInit }[] = []
	const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input)
		calls.push({ url, init })
		return handler(url, init)
	})
	return { fn: fn as unknown as FetchFn, calls }
}

function ctxFor(tool: AgentTool) {
	return {
		sessionId: 'sess-1',
		toolCallId: 'call_1',
		name: tool.name,
		signal: new AbortController().signal,
		scope: {},
	}
}

describe('jev_decide tool', () => {
	it('POSTs state + questions and returns answers', async () => {
		expect.assertions(3)
		const { fn, calls } = mockFetch(
			() =>
				new Response(JSON.stringify({ answers: { q: { type: 'noul', noul: 0.7 } } }), {
					status: 200,
					headers: { 'content-type': 'application/json' },
				})
		)
		const tool = jevDecideTool({ fetchFn: fn, apiKey: 'k' })
		expect(tool.name).toBe('jev_decide')
		const out = (await tool.execute(
			{ state: 's', questions: { q: { type: 'noul', instructions: 'Same?' } } },
			ctxFor(tool)
		)) as { answers: Record<string, unknown> }
		expect(out.answers).toEqual({ q: { type: 'noul', noul: 0.7 } })
		expect(calls).toHaveLength(1)
	})

	it('throws without an apiKey and validates questions', async () => {
		expect.assertions(2)
		const tool = jevDecideTool({})
		await expect(
			tool.execute(
				{ state: 's', questions: { q: { type: 'noul', instructions: 'Same?' } } },
				ctxFor(tool)
			)
		).rejects.toThrow(/no API key/)
		const keyed = jevDecideTool({ apiKey: 'k', fetchFn: mockFetch(() => new Response('{}')).fn })
		await expect(keyed.execute({ state: 's', questions: {} }, ctxFor(keyed))).rejects.toThrow(
			/non-null object|at least 1/
		)
	})
})

describe('jev_match tool', () => {
	it('asks is_same_product and thresholds at 0.8', async () => {
		expect.assertions(3)
		const { fn, calls } = mockFetch(
			() =>
				new Response(
					JSON.stringify({ answers: { is_same_product: { type: 'noul', noul: 0.96 } } }),
					{ status: 200, headers: { 'content-type': 'application/json' } }
				)
		)
		const tool = jevMatchTool({ fetchFn: fn, apiKey: 'k' })
		expect(tool.name).toBe('jev_match')
		const out = (await tool.execute({ a_title: 'A', b_title: 'B' }, ctxFor(tool))) as {
			score: number
			match: boolean
		}
		expect(out).toEqual({ score: 0.96, match: true })
		const body = JSON.parse(String(calls[0].init?.body)) as Record<string, unknown>
		expect((body.questions as Record<string, { type: string }>).is_same_product.type).toBe('noul')
	})

	it('reports match false below threshold and validates titles', async () => {
		expect.assertions(2)
		const { fn } = mockFetch(
			() => new Response(JSON.stringify({ answers: { is_same_product: 0.2 } }), { status: 200 })
		)
		const tool = jevMatchTool({ fetchFn: fn, apiKey: 'k' })
		const out = (await tool.execute({ a_title: 'A', b_title: 'B' }, ctxFor(tool))) as {
			match: boolean
		}
		expect(out.match).toBe(false)
		await expect(tool.execute({ a_title: '', b_title: 'B' }, ctxFor(tool))).rejects.toThrow(
			/non-empty/
		)
	})
})

describe('serp tools', () => {
	it('adapterFor covers every SERP_SOURCES entry', async () => {
		expect.assertions(SERP_SOURCES.length)
		for (const source of SERP_SOURCES) {
			expect(
				adapterFor(source, mockFetch(() => new Response('x')).fn)
					.name.replace('.ro', '')
					.replace('.bg', '')
					.replace('.hu', '')
			).toContain(source.split('.')[0].split('-')[0].slice(0, 4))
		}
	})

	it('serp_details rejects sources without details()', async () => {
		expect.assertions(1)
		const { createLibTool: create } = await import('./registry.js')
		const tool = create('serp_details', { fetchFn: mockFetch(() => new Response('x')).fn })
		await expect(tool.execute({ source: 'aosom', id: 'x' }, ctxFor(tool))).rejects.toThrow(
			/unsupported source/
		)
	})

	it('bodacc_leads validates category/dateFrom and bodacc_parse decodes', async () => {
		expect.assertions(4)
		const { fn } = mockFetch(
			() =>
				new Response(JSON.stringify({ total_count: 0, results: [] }), {
					status: 200,
					headers: { 'content-type': 'application/json' },
				})
		)
		const leads = createLibTool('bodacc_leads', { fetchFn: fn })
		await expect(leads.execute({ category: 'bogus' }, ctxFor(leads))).rejects.toThrow(
			/unknown category/
		)
		await expect(leads.execute({ dateFrom: 'yesterday' }, ctxFor(leads))).rejects.toThrow(
			/YYYY-MM-DD/
		)
		const out = (await leads.execute(
			{ category: 'creation', limit: 5 },
			ctxFor(leads)
		)) as unknown[]
		expect(out).toEqual([])
		expect(
			parseBodaccRecord({
				id: '1',
				registre: ['123 456 789'],
				commercant: 'ACME',
				listepersonnes: null,
				listeetablissements: null,
				jugement: null,
				acte: null,
				depot: null,
			})
		).toMatchObject({ siren: '123456789', name: 'ACME' })
	})
})

describe('registry', () => {
	it('defaults to fetch + websearch and builds every named tool', async () => {
		expect.assertions(2 + LIB_TOOL_NAMES.length)
		expect([...LIB_TOOL_DEFAULTS]).toEqual(['fetch_webpage', 'web_search'])
		const tools = resolveLibTools([...LIB_TOOL_NAMES], {
			fetchFn: mockFetch(() => new Response('x')).fn,
		})
		expect(tools).toHaveLength(LIB_TOOL_NAMES.length)
		for (const tool of tools) expect(tool.name).toMatch(/^[a-z_]+$/)
	})

	it('uses the Typesafe endpoint override without a model', async () => {
		expect.assertions(2)
		const { fn, calls } = mockFetch(
			() => new Response(JSON.stringify({ answers: { q: 0.1 } }), { status: 200 })
		)
		const tool = createLibTool('jev_decide', {
			fetchFn: fn,
			jevApiKey: 'ts',
			jevBaseUrl: JEV_TYPESAFE_URL,
		})
		await tool.execute(
			{ state: 's', questions: { q: { type: 'noul', instructions: 'Same?' } } },
			ctxFor(tool)
		)
		expect(calls[0].url).toBe(JEV_TYPESAFE_URL)
		expect(JSON.parse(String(calls[0].init?.body))).not.toHaveProperty('model')
	})

	it('throws on unknown names', async () => {
		expect.assertions(1)
		expect(() => createLibTool('nope')).toThrow(/unknown lib tool/)
	})
})
