import { describe, expect, it, vi } from 'vitest'
import {
	extractChoice,
	extractNoul,
	JEV_MODEL,
	JEV_OPENROUTER_URL,
	JEV_TYPESAFE_URL,
	JevClient,
	JevError,
} from './client.js'
import type { FetchFn } from './types.js'

// ---------------------------------------------------------------------------
// Fixtures: faithful copies of the Decisions API envelope
// (`~/dev/arb2b/arbitrage_bot/engine/jev_matcher.py`):
// `{ answers: { <id>: { type: 'noul', noul: n } | { choice, ... } } }`.
// Keys stay snake_case — the wire is the contract.
// ---------------------------------------------------------------------------

/** Wrap an `answers` map in the Decisions response envelope. */
function decisionsResponse(answers: Record<string, unknown>, status = 200): Response {
	return new Response(JSON.stringify({ answers }), {
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

/** Parse the JSON body of a recorded call. */
function bodyOf(call: { init?: RequestInit }): Record<string, unknown> {
	return JSON.parse(String(call.init?.body)) as Record<string, unknown>
}

/** Headers of a recorded call, lower-cased. */
function headersOf(call: { init?: RequestInit }): Headers {
	return new Headers(call.init?.headers)
}

// ---------------------------------------------------------------------------

describe('decide (noul)', () => {
	it('POSTs state + questions and returns the answers map', async () => {
		const { fn, calls } = mockFetch(() =>
			decisionsResponse({ is_same_product: { type: 'noul', noul: 0.96 } })
		)
		const client = new JevClient({ apiKey: 'sk-or-v1-test', fetchFn: fn })

		const out = await client.decide({
			state: 'B2B Title: foo\nRetail Title: bar',
			questions: {
				is_same_product: {
					type: 'noul',
					instructions: 'Do these two titles refer to the exact same physical product?',
				},
			},
		})

		expect(out).toEqual({ is_same_product: { type: 'noul', noul: 0.96 } })
		expect(calls).toHaveLength(1)
		expect(calls[0].url).toBe(JEV_OPENROUTER_URL)
		expect(calls[0].init?.method).toBe('POST')
		expect(headersOf(calls[0]).get('authorization')).toBe('Bearer sk-or-v1-test')
		const body = bodyOf(calls[0])
		expect(body.model).toBe(JEV_MODEL)
		expect(body.state).toBe('B2B Title: foo\nRetail Title: bar')
		expect(body.questions).toEqual({
			is_same_product: {
				type: 'noul',
				instructions: 'Do these two titles refer to the exact same physical product?',
			},
		})
	})

	it('omits model for the Typesafe endpoint', async () => {
		const { fn, calls } = mockFetch(() =>
			decisionsResponse({ is_same_product: { type: 'noul', noul: 0.5 } })
		)
		const client = new JevClient({ apiKey: 'ts-key', fetchFn: fn, baseUrl: JEV_TYPESAFE_URL })
		await client.decide({
			state: 'x',
			questions: { q: { type: 'noul', instructions: 'Same?' } },
		})
		expect(calls[0].url).toBe(JEV_TYPESAFE_URL)
		expect(bodyOf(calls[0])).not.toHaveProperty('model')
	})

	it('rejects an empty questions map before any fetch', async () => {
		const { fn, calls } = mockFetch(() => decisionsResponse({}))
		const client = new JevClient({ fetchFn: fn, apiKey: 'k' })
		await expect(client.decide({ state: 'x', questions: {} })).rejects.toBeInstanceOf(JevError)
		expect(calls).toHaveLength(0)
	})

	it('rejects an unknown question type before any fetch', async () => {
		const { fn, calls } = mockFetch(() => decisionsResponse({}))
		const client = new JevClient({ fetchFn: fn, apiKey: 'k' })
		await expect(
			client.decide({
				state: 'x',
				questions: { q: { type: 'bogus', instructions: 'Same?' } } as unknown as {
					q: { type: 'noul'; instructions: string }
				},
			})
		).rejects.toBeInstanceOf(JevError)
		expect(calls).toHaveLength(0)
	})
})

describe('decide (choice)', () => {
	it('returns the best_match answer for batch weighing', async () => {
		const { fn } = mockFetch(() =>
			decisionsResponse({
				best_match: {
					choice: 'c2',
					confidence: 0.9,
					probabilities: { c1: 0.1, c2: 0.9 },
				},
			})
		)
		const client = new JevClient({ apiKey: 'k', fetchFn: fn })

		const out = await client.decide({
			state: { source_item: { title: 'intent' }, candidates: [{ id: 'c1' }, { id: 'c2' }] },
			questions: {
				best_match: {
					type: 'choice',
					instructions: 'Which candidate is the exact same physical product?',
					criteria: { c1: 'cand 1', c2: 'cand 2', none: 'No candidate is the same product' },
				},
			},
		})

		expect(out.best_match).toEqual({
			choice: 'c2',
			confidence: 0.9,
			probabilities: { c1: 0.1, c2: 0.9 },
		})
	})
})

describe('extractNoul / extractChoice', () => {
	it('extracts the noul probability from both answer shapes', async () => {
		expect(extractNoul({ type: 'noul', noul: 0.96 })).toBe(0.96)
		expect(extractNoul(0.42)).toBe(0.42)
		expect(extractNoul({ nope: true })).toBe(0)
	})

	it('normalizes probabilities to scores', async () => {
		expect(
			extractChoice({ choice: 'c2', confidence: 0.9, probabilities: { c1: 0.1, c2: 0.9 } })
		).toEqual({ choice: 'c2', confidence: 0.9, scores: { c1: 0.1, c2: 0.9 } })
		expect(extractChoice({ choice: 'none' })).toEqual({ choice: 'none' })
		expect(extractChoice({ nope: true })).toEqual({})
	})
})

describe('transport', () => {
	it('requires an apiKey at construction', async () => {
		expect(() => new JevClient({ apiKey: '' })).toThrow(JevError)
	})

	it('surfaces non-2xx as http errors with status', async () => {
		const { fn } = mockFetch(
			() =>
				new Response(JSON.stringify({ error: 'bad key' }), {
					status: 401,
					headers: { 'content-type': 'application/json' },
				})
		)
		const client = new JevClient({ fetchFn: fn, apiKey: 'k' })
		const err = await client
			.decide({ state: 'x', questions: { q: { type: 'noul', instructions: 'Same?' } } })
			.catch((e: unknown) => e)
		expect(err).toBeInstanceOf(JevError)
		expect((err as JevError).code).toBe('http')
		expect((err as JevError).status).toBe(401)
	})

	it('uses a custom baseUrl and model when given', async () => {
		const { fn, calls } = mockFetch(() => decisionsResponse({ q: { type: 'noul', noul: 0.5 } }))
		const client = new JevClient({
			apiKey: 'k',
			fetchFn: fn,
			baseUrl: 'https://jev.example/decisions/',
			model: 'custom/model',
		})
		await client.decide({ state: 'x', questions: { q: { type: 'noul', instructions: 'Same?' } } })
		// trailing slash on baseUrl is trimmed
		expect(calls[0].url).toBe('https://jev.example/decisions')
		expect(bodyOf(calls[0]).model).toBe('custom/model')
	})
})
