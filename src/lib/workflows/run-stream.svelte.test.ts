/**
 * `WorkflowRunStream` (`plans/workflow-finalize.md` §6 S6).
 *
 * Run-scoped sibling of `session.svelte.test.ts`: a mocked transport serves
 * SSE bodies for `/wfstreams/*` and JSON for `/poll`, so no live Alfred is
 * touched. Every test asserts (`expect.requireAssertions: true`).
 */

import { describe, expect, it, vi } from 'vitest'
import { AlfredClient, AlfredError } from '../alfred/client.js'
import type { FetchFn, WorkflowRunEvent, WorkflowRunStreamCredential } from '../alfred/types.js'
import {
	isTerminalRunStatus,
	toWorkflowStreamEvent,
	WorkflowRunStream,
	type WorkflowRunStreamOptions,
} from './run-stream.svelte.js'
import type { WorkflowStreamEvent } from './types.js'

// ---------------------------------------------------------------------------
// A mocked transport: SSE bodies for `/wfstreams/{rid}`, JSON for `/poll`.
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

/** One wire run event framed for SSE. */
function frame(evt: WorkflowRunEvent): string {
	return `event: ${evt.type}\ndata: ${JSON.stringify(evt)}\n\n`
}

function opened(seq: number, idx: number, labelText: string): WorkflowRunEvent {
	return {
		seq,
		type: 'interaction_opened',
		payload: { idx, kind: 'tool', tool: 'serp_search', label: 's', label_text: labelText },
	}
}

function resolved(seq: number, idx: number): WorkflowRunEvent {
	return { seq, type: 'interaction_resolved', payload: { idx, status: 'resolved' } }
}

function runStatus(seq: number, status: string): WorkflowRunEvent {
	return { seq, type: 'run_status', payload: { status } }
}

/**
 * A fetch mock: `/wfstreams/{rid}/poll` answers `pollJson`, `/wfstreams/*`
 * streams `frames` (or answers `sseStatus` when set), else `json`.
 */
function mockFetch(
	frames: string[] = [],
	opts: {
		pollJson?: unknown
		sseStatus?: number
		sseDetail?: string
	} = {}
) {
	const calls: { url: string; init?: RequestInit }[] = []
	const pollJson = opts.pollJson ?? { events: [], next_seq: 1, timeout: true }
	const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input)
		calls.push({ url, init })
		if (url.includes('/wfstreams/') && url.includes('/poll')) return jsonResponse(pollJson)
		if (url.includes('/wfstreams/')) {
			if (opts.sseStatus !== undefined)
				return jsonResponse({ detail: opts.sseDetail ?? 'boom' }, opts.sseStatus)
			return new Response(sseBody(frames), { status: 200 })
		}
		return jsonResponse({ ok: true })
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

const CRED: WorkflowRunStreamCredential = {
	run_id: 'run-1',
	stream_token: 'tok-1',
	stream_url: 'http://localhost:8192/wfstreams/run-1',
}

function stream(fn: FetchFn, opts: Partial<WorkflowRunStreamOptions> = {}) {
	return new WorkflowRunStream({
		client: new AlfredClient({ fetchFn: fn }),
		reconnectDelayMs: () => 0,
		...opts,
	})
}

// ---------------------------------------------------------------------------

describe('toWorkflowStreamEvent / isTerminalRunStatus', () => {
	it('spreads the payload back under its type (inverse of runEventPayload)', () => {
		expect.assertions(2)
		const out = toWorkflowStreamEvent(opened(3, 7, 'Search'))
		expect(out).toEqual({
			type: 'interaction_opened',
			idx: 7,
			kind: 'tool',
			tool: 'serp_search',
			label: 's',
			label_text: 'Search',
		})
		expect(isTerminalRunStatus({ type: 'run_status', status: 'done' })).toBe(true)
	})

	it('only terminal run_status counts as terminal', () => {
		expect.assertions(3)
		expect(isTerminalRunStatus({ type: 'run_status', status: 'running' })).toBe(false)
		expect(isTerminalRunStatus({ type: 'run_status', status: 'waiting' })).toBe(false)
		expect(isTerminalRunStatus({ type: 'interaction_opened', idx: 0 } as WorkflowStreamEvent)).toBe(
			false
		)
	})
})

describe('attach / ingest', () => {
	it('attaches a credential, converts wire events and advances the cursor', async () => {
		expect.assertions(6)
		const { fn, calls } = mockFetch([
			frame(opened(1, 0, 'Search')),
			frame(resolved(2, 0)),
			frame(runStatus(3, 'running')),
		])
		const s = stream(fn)

		await s.attach(CRED)
		await s.attached

		expect(s.id).toBe('run-1')
		expect(s.status).toBe('running')
		expect(s.lastSeq).toBe(3)
		expect(s.events).toEqual([
			{
				type: 'interaction_opened',
				idx: 0,
				kind: 'tool',
				tool: 'serp_search',
				label: 's',
				label_text: 'Search',
			},
			{ type: 'interaction_resolved', idx: 0, status: 'resolved' },
			{ type: 'run_status', status: 'running' },
		])
		expect(calls[0].url).toBe('http://localhost:8192/wfstreams/run-1?after_seq=0')
		expect(new Headers(calls[0].init?.headers).get('authorization')).toBe('Bearer tok-1')
	})

	it('appends live events in order across replays', async () => {
		expect.assertions(2)
		const { fn } = mockFetch([frame(opened(1, 0, 'A')), frame(opened(2, 1, 'B'))])
		const s = stream(fn)
		await s.attach(CRED)
		await s.attached

		expect(s.events.map((e) => (e as { label_text?: string }).label_text)).toEqual(['A', 'B'])
		expect(s.lastSeq).toBe(2)
	})

	it('re-attaching the same run resumes from the durable cursor', async () => {
		expect.assertions(1)
		const { fn, calls } = mockFetch([frame(runStatus(9, 'running'))])
		const s = stream(fn)
		await s.attach(CRED)
		await s.attached
		await s.attach(CRED)
		await s.attached

		expect(calls[1].url).toContain('after_seq=9')
	})

	it('attaching a new run id resets events, cursor and status', async () => {
		expect.assertions(3)
		const { fn } = mockFetch([frame(opened(1, 0, 'A'))])
		const s = stream(fn)
		await s.attach(CRED)
		await s.attached
		expect(s.events).toHaveLength(1)

		const CRED2: WorkflowRunStreamCredential = {
			run_id: 'run-2',
			stream_token: 'tok-2',
			stream_url: 'http://localhost:8192/wfstreams/run-2',
		}
		await s.attach(CRED2)
		await s.attached
		expect(s.id).toBe('run-2')
		expect(s.events.map((e) => (e as { label_text?: string }).label_text)).toEqual(['A'])
	})

	it('a terminal run_status ends the loop with the terminal status', async () => {
		expect.assertions(4)
		const { fn } = mockFetch([frame(opened(1, 0, 'A')), frame(runStatus(2, 'done'))])
		const s = stream(fn)

		await s.attach(CRED)
		await s.attached

		expect(s.status).toBe('done')
		expect(s.lastSeq).toBe(2)
		expect(s.isStreaming).toBe(false)
		expect(s.error).toBeNull()
	})

	it('rejects attach without a run id', async () => {
		expect.assertions(1)
		const { fn } = mockFetch()
		const s = stream(fn)
		await expect(s.attach(null)).rejects.toBeInstanceOf(AlfredError)
	})
})

describe('refreshStream', () => {
	/** A fetch that 401s until the token matches `good`, then succeeds. */
	function authFetch(good: string) {
		const calls: { url: string; auth: string | null }[] = []
		const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input)
			const auth = new Headers(init?.headers).get('authorization')
			calls.push({ url, auth })
			if (auth !== `Bearer ${good}`) return jsonResponse({ detail: 'expired' }, 401)
			if (url.includes('/wfstreams/'))
				return new Response(sseBody([frame(runStatus(1, 'running'))]))
			return jsonResponse({ ok: true })
		})
		return { fn: fn as unknown as FetchFn, calls }
	}

	it('refreshes the run capability on 401 and retries once', async () => {
		expect.assertions(4)
		const { fn, calls } = authFetch('fresh')
		const refresh = vi.fn(async () => ({ ...CRED, stream_token: 'fresh' }))
		const s = new WorkflowRunStream({
			client: new AlfredClient({ fetchFn: fn }),
			refreshStream: refresh,
			reconnectDelayMs: () => 0,
		})
		// attach installs CRED's token (tok-1); the mock 401s until 'fresh'.
		await s.attach(CRED)
		await s.attached

		expect(refresh).toHaveBeenCalledTimes(1)
		expect(calls.map((c) => c.auth)).toEqual(['Bearer tok-1', 'Bearer fresh'])
		expect(s.status).toBe('running')
		expect(s.lastSeq).toBe(1)
	})
})

describe('poll fallback', () => {
	it('engages the /poll fallback after consecutive SSE failures (never in parallel)', async () => {
		expect.assertions(4)
		const pollEvents = [opened(5, 2, 'Late'), runStatus(6, 'running')]
		const { fn, calls } = mockFetch([], {
			sseStatus: 500,
			sseDetail: 'alfred down',
			pollJson: { events: pollEvents, next_seq: 7, timeout: false },
		})
		const s = stream(fn, { pollFallbackAfter: 1 })

		await s.attach(CRED)
		await s.attached

		const urls = calls.map((c) => c.url)
		expect(urls.filter((u) => u.includes('/poll'))).toHaveLength(1)
		expect(urls[0]).toBe('http://localhost:8192/wfstreams/run-1?after_seq=0')
		expect(s.events.map((e) => e.type)).toEqual(['interaction_opened', 'run_status'])
		expect(s.lastSeq).toBe(6)
	})

	it('surfaces a poll failure as status error + message', async () => {
		expect.assertions(2)
		const fn = vi.fn(async () => jsonResponse({ detail: 'gone' }, 410))
		const s = stream(fn as unknown as FetchFn, { pollFallbackAfter: 1 })
		await s.attach(CRED)
		await s.attached

		expect(s.status).toBe('error')
		expect(s.error).toBe('gone')
	})
})

describe('event log bound', () => {
	it('drops the oldest events beyond the cap but keeps the cursor', async () => {
		expect.assertions(3)
		const { fn } = mockFetch([
			frame(opened(1, 0, 'A')),
			frame(opened(2, 1, 'B')),
			frame(opened(3, 2, 'C')),
		])
		const s = stream(fn, { eventLogLimit: 2 })
		await s.attach(CRED)
		await s.attached

		expect(s.events).toHaveLength(2)
		expect(s.events.map((e) => (e as { idx?: number }).idx)).toEqual([1, 2])
		expect(s.lastSeq).toBe(3)
	})

	it('eventLogLimit 0 disables the log but keeps the cursor advancing', async () => {
		expect.assertions(2)
		const { fn } = mockFetch([frame(opened(1, 0, 'A')), frame(runStatus(2, 'running'))])
		const s = stream(fn, { eventLogLimit: 0 })
		await s.attach(CRED)
		await s.attached

		expect(s.events).toEqual([])
		expect(s.lastSeq).toBe(2)
	})
})

describe('isStreaming', () => {
	it('tracks the connection', async () => {
		expect.assertions(3)
		const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			if (String(input).includes('/wfstreams/')) {
				const body = new ReadableStream<Uint8Array>({
					start(controller) {
						init?.signal?.addEventListener('abort', () => controller.close())
					},
				})
				return new Response(body, { status: 200 })
			}
			return jsonResponse({ ok: true })
		}) as unknown as FetchFn
		const s = stream(fn)
		expect(s.isStreaming).toBe(false)

		void s.attach(CRED)
		await waitFor(() => s.isStreaming)
		expect(s.isStreaming).toBe(true)

		s.dispose()
		expect(s.isStreaming).toBe(false)
	})
})

describe('dispose / reset', () => {
	it('dispose aborts the loop without flipping to error', async () => {
		expect.assertions(3)
		const encoder = new TextEncoder()
		const evt = opened(1, 0, 'A')
		const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			if (String(input).includes('/wfstreams/')) {
				const body = new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(encoder.encode(frame(evt)))
						init?.signal?.addEventListener('abort', () => controller.close())
					},
				})
				return new Response(body, { status: 200 })
			}
			return jsonResponse({ ok: true })
		}) as unknown as FetchFn
		const s = stream(fn)
		void s.attach(CRED)
		await waitFor(() => s.events.length === 1)
		expect(s.events).toHaveLength(1)

		s.dispose()
		await s.attached
		expect(s.status).not.toBe('error')
		expect(s.error).toBeNull()
	})

	it('reset clears every field', async () => {
		expect.assertions(5)
		const { fn } = mockFetch([frame(opened(1, 0, 'A')), frame(runStatus(2, 'running'))])
		const s = stream(fn)
		await s.attach(CRED)
		await s.attached

		s.reset()
		expect(s.id).toBeNull()
		expect(s.status).toBe('idle')
		expect(s.lastSeq).toBe(0)
		expect(s.events).toEqual([])
		expect(s.error).toBeNull()
	})
})
