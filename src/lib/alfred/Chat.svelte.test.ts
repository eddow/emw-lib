import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-svelte'
import ChatTestHost from './ChatTestHost.svelte'
import type { StreamCredential } from './types.js'

/** SSE frames the mocked `/streams/*` serves. */
function frames(text: string): string[] {
	const answer = `event: answer\ndata: ${JSON.stringify({
		seq: 1,
		type: 'answer',
		payload: { text },
		ts: 't',
	})}\n\n`
	const done = `event: done\ndata: ${JSON.stringify({
		seq: 2,
		type: 'done',
		payload: { reason: 'stop' },
		ts: 't',
	})}\n\n`
	return [answer, done]
}

const CRED: StreamCredential = {
	generation_id: 'gen_1',
	stream_token: 'tok-1',
	stream_url: 'http://localhost:8192/streams/gen_1',
}

function installFetch(answerText = 'Hello from Alfred') {
	const calls: { url: string; init?: RequestInit }[] = []
	const encoder = new TextEncoder()
	const origFetch = globalThis.fetch
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input)
		calls.push({ url, init })
		if (url.includes('/streams/gen_1')) {
			const body = new ReadableStream({
				start(controller) {
					for (const f of frames(answerText)) controller.enqueue(encoder.encode(f))
					controller.close()
				},
			})
			return new Response(body, { status: 200 })
		}
		return Response.json({ ok: true })
	}) as unknown as typeof fetch
	return {
		calls,
		restore: () => {
			globalThis.fetch = origFetch
		},
	}
}

describe('Chat', () => {
	it('attaches the stream credential and renders the answer', async () => {
		const net = installFetch()
		try {
			const screen = await render(ChatTestHost, { credential: CRED })

			// Stream attached on mount; the answer renders as a message.
			const messages = screen.getByTestId('alfred-chat-messages')
			await expect
				.element(messages.getByTestId('alfred-chat-message').first())
				.toHaveTextContent('Hello from Alfred')
			expect(net.calls[0].url).toBe('http://localhost:8192/streams/gen_1?after_seq=0')
			expect(new Headers(net.calls[0].init?.headers).get('authorization')).toBe('Bearer tok-1')
		} finally {
			net.restore()
		}
	})

	it('sends via onsend and attaches the returned credential', async () => {
		const net = installFetch()
		try {
			const next: StreamCredential = {
				generation_id: 'gen_2',
				stream_token: 'tok-2',
				stream_url: 'http://localhost:8192/streams/gen_2',
			}
			const onsend = vi.fn(async (_prompt: string) => next)
			const screen = await render(ChatTestHost, { credential: CRED, onsend })
			const messages = screen.getByTestId('alfred-chat-messages')
			await expect
				.element(messages.getByTestId('alfred-chat-message').first())
				.toHaveTextContent('Hello from Alfred')

			const input = screen.getByTestId('alfred-chat-input')
			await input.fill('Hi Alfred')
			await screen.getByTestId('alfred-chat-send').click()
			await vi.waitFor(() => {
				expect(onsend).toHaveBeenCalledWith('Hi Alfred')
			})
		} finally {
			net.restore()
		}
	})

	it('targets the credential URL and sends the stream token', async () => {
		const calls: { url: string; init?: RequestInit }[] = []
		const encoder = new TextEncoder()
		const origFetch = globalThis.fetch
		globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input)
			calls.push({ url, init })
			const body = new ReadableStream({
				start(controller) {
					for (const f of frames('hi')) controller.enqueue(encoder.encode(f))
					controller.close()
				},
			})
			return new Response(body, { status: 200 })
		}) as unknown as typeof fetch
		try {
			await render(ChatTestHost, {
				credential: {
					generation_id: 'gen_9',
					stream_token: 'tok-abc',
					stream_url: 'https://alfred.example:8192/streams/gen_9',
				},
			})
			await vi.waitFor(() => {
				expect(calls.length).toBeGreaterThan(0)
			})
			expect(calls[0].url).toBe('https://alfred.example:8192/streams/gen_9?after_seq=0')
			for (const call of calls) {
				expect(new Headers(call.init?.headers).get('authorization')).toBe('Bearer tok-abc')
			}
		} finally {
			globalThis.fetch = origFetch
		}
	})

	it('surfaces a stream failure as role=alert and keeps the form', async () => {
		const origFetch = globalThis.fetch
		globalThis.fetch = (async () =>
			Response.json({ detail: 'generation ended' }, { status: 410 })) as unknown as typeof fetch
		try {
			const screen = await render(ChatTestHost, { credential: CRED })
			await expect.element(screen.getByTestId('alfred-chat-error')).toBeVisible()
			await expect
				.element(screen.getByTestId('alfred-chat-error'))
				.toHaveTextContent('generation ended')
			// Composer still there (not a dead end).
			await expect.element(screen.getByTestId('alfred-chat-send')).toBeVisible()
		} finally {
			globalThis.fetch = origFetch
		}
	})
})
