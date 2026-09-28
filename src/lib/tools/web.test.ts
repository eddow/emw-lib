import { describe, expect, it, vi } from 'vitest'
import type { AgentTool } from '../alfred/tools.js'
import type { FetchFn } from '../serps/types.js'
import { fetchWebpage, fetchWebpageTool, htmlToText } from './fetch.js'
import {
	parseBraveResponse,
	parseDuckDuckGoResponse,
	webSearch,
	webSearchTool,
} from './websearch.js'

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
	const calls: { url: string; init?: RequestInit }[] = []
	const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input)
		calls.push({ url, init })
		return handler(url, init)
	})
	return { fn: fn as unknown as FetchFn, calls }
}

async function runTool(tool: AgentTool, input: unknown): Promise<unknown> {
	return tool.execute(input, {
		sessionId: 'sess-1',
		toolCallId: 'call_1',
		name: tool.name,
		signal: new AbortController().signal,
		scope: {},
	})
}

describe('htmlToText', () => {
	it('extracts title and strips tags', async () => {
		expect.assertions(2)
		const { title, text } = htmlToText(
			'<html><head><title>Acme</title><style>.x{}</style></head><body><script>1</script><h1>Hello <b>world</b></h1></body></html>'
		)
		expect(title).toBe('Acme')
		expect(text).toBe('Acme Hello world')
	})
})

describe('fetch_webpage', () => {
	it('returns url/status/title/text capped at max_chars', async () => {
		expect.assertions(5)
		const { fn, calls } = mockFetch(
			() =>
				new Response('<html><head><title>T</title></head><body><p>hello world</p></body></html>', {
					status: 200,
					headers: { 'content-type': 'text/html' },
				})
		)
		const out = await fetchWebpage('https://example.com/a', fn, 5)
		expect(calls[0].url).toBe('https://example.com/a')
		expect(out.status).toBe(200)
		expect(out.title).toBe('T')
		expect(out.text).toBe('T hel')
		expect(out.url).toBe('https://example.com/a')
	})

	it('rejects non-http(s) urls and non-2xx without fetching', async () => {
		expect.assertions(3)
		const { fn, calls } = mockFetch(() => new Response('x', { status: 200 }))
		await expect(fetchWebpage('ftp://example.com/x', fn)).rejects.toThrow(/http\(s\)/)
		await expect(fetchWebpage('not a url', fn)).rejects.toThrow(/invalid url/)
		expect(calls).toHaveLength(0)
	})

	it('throws on non-2xx with status in the message', async () => {
		expect.assertions(1)
		const { fn } = mockFetch(() => new Response('nope', { status: 404, statusText: 'Gone' }))
		await expect(fetchWebpage('https://example.com/missing', fn)).rejects.toThrow(/404/)
	})

	it('tool wrapper validates url', async () => {
		const out = (await runTool(
			fetchWebpageTool(
				mockFetch(() => new Response('<title>T</title><p>hi</p>', { status: 200 })).fn
			),
			{
				url: 'https://example.com/',
			}
		)) as { title: string }
		expect(out.title).toBe('T')
	})
})

describe('web_search parsers', () => {
	it('parses Brave web.results', async () => {
		expect.assertions(1)
		expect(
			parseBraveResponse({ web: { results: [{ title: 'A', url: 'https://a.example/' }] } })
		).toEqual([
			{ title: 'A', id: 'https://a.example/', url: 'https://a.example/', description: null },
		])
	})

	it('parses DuckDuckGo result anchors', async () => {
		expect.assertions(2)
		const entries = parseDuckDuckGoResponse(
			'<a class="result__a" href="https://a.example/">A &amp; B</a><a class="result__a" href="https://b.example/"><b>C</b></a>'
		)
		expect(entries).toHaveLength(2)
		expect(entries[0]).toEqual({
			title: 'A & B',
			id: 'https://a.example/',
			url: 'https://a.example/',
		})
	})
})

describe('web_search', () => {
	it('uses DuckDuckGo without a key and clamps the limit', async () => {
		expect.assertions(3)
		const { fn, calls } = mockFetch(
			() =>
				new Response('<a class="result__a" href="https://a.example/">A</a>', {
					status: 200,
					headers: { 'content-type': 'text/html' },
				})
		)
		const out = await webSearch('acme', { fetchFn: fn }, 99)
		expect(calls[0].url).toContain('html.duckduckgo.com/html/')
		expect(out).toHaveLength(1)
		expect(out[0].url).toBe('https://a.example/')
	})

	it('uses Brave with a key', async () => {
		expect.assertions(3)
		const { fn, calls } = mockFetch(
			() =>
				new Response(
					JSON.stringify({ web: { results: [{ title: 'A', url: 'https://a.example/' }] } }),
					{
						status: 200,
						headers: { 'content-type': 'application/json' },
					}
				)
		)
		const out = await webSearch('acme', { fetchFn: fn, apiKey: 'brave-key' })
		expect(calls[0].url).toContain('api.search.brave.com')
		expect(new Headers(calls[0].init?.headers).get('X-Subscription-Token')).toBe('brave-key')
		expect(out).toHaveLength(1)
	})

	it('rejects blank queries and validates via the tool wrapper', async () => {
		expect.assertions(2)
		const { fn } = mockFetch(() => new Response('x', { status: 200 }))
		await expect(webSearch('  ', { fetchFn: fn })).rejects.toThrow(/must not be empty/)
		await expect(runTool(webSearchTool({ fetchFn: fn }), { q: '' })).rejects.toThrow(/non-empty/)
	})
})
