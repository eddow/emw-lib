import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-svelte'
import ChatTestHost from './ChatTestHost.svelte'

/** SSE frames the mocked `/events` stream serves. */
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

function installFetch(answerText = 'Hello from Alfred') {
	const calls: { url: string; init?: RequestInit }[] = []
	const encoder = new TextEncoder()
	const origFetch = globalThis.fetch
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input)
		calls.push({ url, init })
		if (url.includes('/events')) {
			const body = new ReadableStream({
				start(controller) {
					for (const f of frames(answerText)) controller.enqueue(encoder.encode(f))
					controller.close()
				},
			})
			return new Response(body, { status: 200 })
		}
		if (url.includes('/history')) return Response.json({ events: [] })
		if (url.endsWith('/sessions')) return Response.json({ session_id: 'sess-1' }, { status: 201 })
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
	it('creates a session, streams the answer and sends a prompt', async () => {
		const net = installFetch()
		try {
			const screen = await render(ChatTestHost, {
				credential: { token: 'tok-1', base_url: 'http://localhost:8192' },
			})

			// Session created on mount; the streamed answer renders as a message.
			const messages = screen.getByTestId('alfred-chat-messages')
			await expect
				.element(messages.getByTestId('alfred-chat-message').first())
				.toHaveTextContent('Hello from Alfred')

			// Composer sends via queue with { prompt }.
			const input = screen.getByTestId('alfred-chat-input')
			await input.fill('Hi Alfred')
			await screen.getByTestId('alfred-chat-send').click()
			await vi.waitFor(() => {
				const queued = net.calls.find((c) => c.url.endsWith('/sessions/sess-1/queue'))
				expect(queued).toBeDefined()
			})
			const queued = net.calls.find((c) => c.url.endsWith('/sessions/sess-1/queue'))
			expect(JSON.parse(String(queued?.init?.body))).toEqual({ prompt: 'Hi Alfred' })
		} finally {
			net.restore()
		}
	})

	it('targets the credential URL and sends the bearer token', async () => {
		const net = installFetch()
		try {
			await render(ChatTestHost, {
				credential: { token: 'tok-abc', base_url: 'https://alfred.example:8192/' },
			})
			await vi.waitFor(() => {
				expect(net.calls.length).toBeGreaterThan(0)
			})
			// Trailing slash trimmed; every request carries the bearer token.
			expect(net.calls[0].url).toBe('https://alfred.example:8192/sessions')
			for (const call of net.calls) {
				expect(new Headers(call.init?.headers).get('authorization')).toBe('Bearer tok-abc')
			}
		} finally {
			net.restore()
		}
	})

	it('binds the created session id back to the parent', async () => {
		const net = installFetch()
		try {
			// Host starts with sessionId null; Chat must write 'sess-1' back.
			const screen = await render(ChatTestHost, {
				credential: { token: 'tok-1', base_url: 'http://localhost:8192' },
				sessionId: null,
			})
			const messages = screen.getByTestId('alfred-chat-messages')
			await expect
				.element(messages.getByTestId('alfred-chat-message').first())
				.toHaveTextContent('Hello from Alfred')
			expect(net.calls[0].url).toBe('http://localhost:8192/sessions')
			await expect.element(screen.getByTestId('host-session-id')).toHaveTextContent('sess-1')
		} finally {
			net.restore()
		}
	})

	it('recovers an existing session instead of creating one', async () => {
		const history = {
			events: [
				{ kind: 'message', seq: 1, role: 'user', content: 'earlier question' },
				{
					kind: 'event',
					seq: 1,
					type: 'answer',
					payload: { text: 'earlier answer' },
					ts: 't',
				},
			],
		}
		const calls: { url: string; init?: RequestInit }[] = []
		const origFetch = globalThis.fetch
		globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input)
			calls.push({ url, init })
			if (url.includes('/events')) {
				const body = new ReadableStream({
					start(controller) {
						controller.close()
					},
				})
				return new Response(body, { status: 200 })
			}
			if (url.includes('/history')) return Response.json(history)
			return Response.json({ ok: true })
		}) as unknown as typeof fetch
		try {
			const screen = await render(ChatTestHost, {
				credential: { token: 'tok-1', base_url: 'http://localhost:8192' },
				sessionId: 'sess-existing',
			})
			// Recovered history renders; no POST /sessions was issued.
			const messages = screen.getByTestId('alfred-chat-messages')
			await expect
				.element(messages.getByTestId('alfred-chat-message').first())
				.toHaveTextContent('earlier question')
			expect(calls.some((c) => c.init?.method === 'POST' && c.url.endsWith('/sessions'))).toBe(
				false
			)
			expect(calls.some((c) => c.url.includes('/sessions/sess-existing/history'))).toBe(true)
			expect(calls.some((c) => c.url.includes('/sessions/sess-existing/events'))).toBe(true)
		} finally {
			globalThis.fetch = origFetch
		}
	})

	it('surfaces a create failure as role=alert and keeps the form', async () => {
		const origFetch = globalThis.fetch
		globalThis.fetch = (async () =>
			Response.json({ detail: 'no model here' }, { status: 400 })) as unknown as typeof fetch
		try {
			const screen = await render(ChatTestHost)
			await expect.element(screen.getByTestId('alfred-chat-error')).toBeVisible()
			await expect
				.element(screen.getByTestId('alfred-chat-error'))
				.toHaveTextContent('no model here')
			// Composer still there (not a dead end).
			await expect.element(screen.getByTestId('alfred-chat-send')).toBeVisible()
		} finally {
			globalThis.fetch = origFetch
		}
	})
})
