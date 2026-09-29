import { describe, expect, it, vi } from 'vitest'
import { OPENROUTER_MODELS_URL, OpenRouterClient, OpenRouterError } from './client.js'
import type { FetchFn } from './types.js'

// ---------------------------------------------------------------------------
// Fixtures: faithful copies of the `GET /models` envelope:
// `{ data: [{ id, ... }] }`. Only `id` is guaranteed per entry.
// ---------------------------------------------------------------------------

/** Wrap a `data` array in the models-list response envelope. */
function modelsResponse(data: Record<string, unknown>[], status = 200): Response {
	return new Response(JSON.stringify({ data }), {
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

/** Headers of a recorded call, lower-cased. */
function headersOf(call: { init?: RequestInit }): Headers {
	return new Headers(call.init?.headers)
}

// ---------------------------------------------------------------------------

describe('listModels', () => {
	it('GETs the models endpoint and returns the data array', async () => {
		const { fn, calls } = mockFetch(() =>
			modelsResponse([
				{ id: 'anthropic/claude-sonnet-4', name: 'Anthropic: Claude Sonnet 4' },
				{ id: 'openai/gpt-5', context_length: 400000 },
			])
		)
		const client = new OpenRouterClient({ apiKey: 'sk-or-v1-test', fetchFn: fn })

		const out = await client.listModels()

		expect(out).toHaveLength(2)
		expect(out[0].id).toBe('anthropic/claude-sonnet-4')
		expect(out[1].id).toBe('openai/gpt-5')
		expect(calls).toHaveLength(1)
		expect(calls[0].url).toBe(OPENROUTER_MODELS_URL)
		expect(calls[0].init?.method).toBe('GET')
		expect(headersOf(calls[0]).get('authorization')).toBe('Bearer sk-or-v1-test')
	})

	it('rejects a response without a data array', async () => {
		const { fn } = mockFetch(
			() =>
				new Response(JSON.stringify({ nope: true }), {
					status: 200,
					headers: { 'content-type': 'application/json' },
				})
		)
		const client = new OpenRouterClient({ apiKey: 'k', fetchFn: fn })
		const err = await client.listModels().catch((e: unknown) => e)
		expect(err).toBeInstanceOf(OpenRouterError)
		expect((err as OpenRouterError).code).toBe('parse')
	})
})

describe('transport', () => {
	it('requires an apiKey at construction', async () => {
		expect(() => new OpenRouterClient({ apiKey: '' })).toThrow(OpenRouterError)
	})

	it('surfaces non-2xx as http errors with status', async () => {
		const { fn } = mockFetch(
			() =>
				new Response(JSON.stringify({ error: 'bad key' }), {
					status: 401,
					headers: { 'content-type': 'application/json' },
				})
		)
		const client = new OpenRouterClient({ fetchFn: fn, apiKey: 'k' })
		const err = await client.listModels().catch((e: unknown) => e)
		expect(err).toBeInstanceOf(OpenRouterError)
		expect((err as OpenRouterError).code).toBe('http')
		expect((err as OpenRouterError).status).toBe(401)
	})

	it('uses a custom baseUrl when given', async () => {
		const { fn, calls } = mockFetch(() => modelsResponse([{ id: 'a/b' }]))
		const client = new OpenRouterClient({
			apiKey: 'k',
			fetchFn: fn,
			baseUrl: 'https://example.test/models/',
		})
		await client.listModels()
		// trailing slash on baseUrl is trimmed
		expect(calls[0].url).toBe('https://example.test/models')
	})
})
