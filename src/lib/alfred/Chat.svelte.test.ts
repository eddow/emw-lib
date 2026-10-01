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
		if (url.includes('/streams/')) {
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
				// Stream completed (done → idle), so the next send creates
				// a new generation via `prompt`, not `queue`.
				expect(onsend).toHaveBeenCalledWith('Hi Alfred', 'prompt')
			})
			// The returned credential is attached live (no remount): the new
			// generation's answer streams on the same mount (B1).
			await expect
				.element(messages.getByTestId('alfred-chat-message').last())
				.toHaveTextContent('Hello from Alfred')
			expect(net.calls.some((c) => c.url.includes('/streams/gen_2'))).toBe(true)
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

	it('renders durable history when no generation is live (reload case)', async () => {
		const screen = await render(ChatTestHost, {
			credential: null,
			history: [
				{ kind: 'message', seq: 1, role: 'user', content: 'first question' },
				{ kind: 'message', seq: 2, role: 'assistant', content: 'first answer' },
				{ kind: 'message', seq: 3, role: 'user', content: 'second question' },
				{ kind: 'message', seq: 4, role: 'assistant', content: 'second answer' },
			],
		})
		const messages = screen.getByTestId('alfred-chat-messages')
		await expect.element(messages.getByTestId('alfred-chat-message').first()).toBeVisible()
		await expect.element(messages).toHaveTextContent('first question')
		await expect.element(messages).toHaveTextContent('second answer')
		// No stream attached, but the composer is usable (first send creates one).
		await expect.element(screen.getByTestId('alfred-chat-send')).toBeVisible()
	})

	it('renders an ask_human card and posts the answer to Alfred directly', async () => {
		const calls: { url: string; init?: RequestInit }[] = []
		const encoder = new TextEncoder()
		const origFetch = globalThis.fetch
		const question = `event: human_question\ndata: ${JSON.stringify({
			seq: 3,
			type: 'human_question',
			payload: {
				tool_call_id: 'call_1',
				name: 'ask_human',
				questions: [{ id: 'q', text: 'Pick?', options: ['a', 'b'] }],
				timeout_s: 0,
				on_timeout: 'autopick',
			},
			ts: 't',
		})}\n\n`
		globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input)
			calls.push({ url, init })
			if (url.includes('/answer/')) return Response.json({ ok: true, duplicate: false })
			const body = new ReadableStream({
				start(controller) {
					controller.enqueue(encoder.encode(question))
					// Hold the stream open: the card must stay interactive.
					// (Never close — the component disposes it on unmount.)
				},
			})
			return new Response(body, { status: 200 })
		}) as unknown as typeof fetch
		try {
			const screen = await render(ChatTestHost, { credential: CRED })
			await expect.element(screen.getByTestId('alfred-human-card')).toBeVisible()
			// First option is the preferred default (marked selected).
			const options = screen.getByTestId('alfred-human-option')
			await expect.element(options.first()).toHaveAttribute('data-selected', 'true')
			await screen.getByTestId('alfred-human-submit').click()
			await vi.waitFor(() => {
				expect(calls.some((c) => c.url.includes('/answer/call_1'))).toBe(true)
			})
			const post = calls.find((c) => c.url.includes('/answer/call_1'))!
			expect(post.url).toBe('http://localhost:8192/streams/gen_1/answer/call_1')
			expect(new Headers(post.init?.headers).get('authorization')).toBe('Bearer tok-1')
			expect(new Headers(post.init?.headers).get('x-alfred-secret')).toBeNull()
			const body = JSON.parse(post.init?.body as string)
			expect(body.answers).toEqual([{ id: 'q', choice: 'a', autopicked: false, timed_out: false }])
		} finally {
			globalThis.fetch = origFetch
		}
	})

	it('renders markdown in assistant answers', async () => {
		const net = installFetch('**bold** and `code`')
		try {
			const screen = await render(ChatTestHost, { credential: CRED })
			const messages = screen.getByTestId('alfred-chat-messages')
			await expect.element(messages).toHaveTextContent('bold')
			await vi.waitFor(() => {
				expect(messages.element().querySelector('strong')?.textContent).toBe('bold')
			})
			expect(messages.element().querySelector('code')?.textContent).toBe('code')
		} finally {
			net.restore()
		}
	})

	it('collapses a paired tool_use→tool_result into one row with details', async () => {
		const screen = await render(ChatTestHost, {
			credential: null,
			history: [
				{
					kind: 'event',
					seq: 1,
					type: 'tool_use',
					payload: { tool_call_id: 'c1', name: 'search', arguments: { q: 'x' } },
					ts: 't',
				},
				{
					kind: 'event',
					seq: 2,
					type: 'tool_result',
					payload: { tool_call_id: 'c1', name: 'search', output: 'found it' },
					ts: 't',
				},
			],
		})
		const row = screen.getByTestId('alfred-tool-call')
		await expect.element(row).toBeVisible()
		await expect.element(row).toHaveTextContent('search')
		await expect.element(screen.getByTestId('alfred-tool-settled')).toBeVisible()
		// Full args/output live in the expandable details.
		await expect.element(row).toHaveTextContent('found it')
	})

	it('renders superseded/archived as a status line, stop as nothing', async () => {
		const screen = await render(ChatTestHost, {
			credential: null,
			history: [
				{ kind: 'event', seq: 1, type: 'done', payload: { reason: 'stop' }, ts: 't' },
				{ kind: 'event', seq: 2, type: 'done', payload: { reason: 'superseded' }, ts: 't' },
				{ kind: 'event', seq: 3, type: 'done', payload: { reason: 'archived' }, ts: 't' },
			],
		})
		const lines = screen.getByTestId('alfred-status-line')
		await expect.element(lines.first()).toBeVisible()
		await expect.element(screen.getByTestId('alfred-chat-messages')).toHaveTextContent('Superseded')
		await expect.element(screen.getByTestId('alfred-chat-messages')).toHaveTextContent('archived')
	})

	it('renders max_iterations as a retry box; Try-again calls onretry', async () => {
		const onretry = vi.fn()
		const { buildTranscript } = await import('./transcript.js')
		// Sanity: the transcript layer maps done/max_iterations → retry.
		const msgs = buildTranscript(
			[
				{
					kind: 'event',
					seq: 1,
					type: 'answer',
					payload: { text: 'partial work' },
					ts: 't',
				},
				{ kind: 'event', seq: 2, type: 'done', payload: { reason: 'max_iterations' }, ts: 't' },
			],
			[]
		)
		expect(msgs.some((m) => m.kind === 'retry')).toBe(true)
		const screen = await render(ChatTestHost, {
			credential: null,
			history: [
				{
					kind: 'event',
					seq: 1,
					type: 'answer',
					payload: { text: 'partial work' },
					ts: 't',
				},
				{ kind: 'event', seq: 2, type: 'done', payload: { reason: 'max_iterations' }, ts: 't' },
			],
			onretry,
		})
		const box = screen.getByTestId('alfred-retry-box')
		await expect.element(box).toBeVisible()
		await screen.getByTestId('alfred-retry-button').click()
		await vi.waitFor(() => {
			expect(onretry).toHaveBeenCalledTimes(1)
		})
		// Clicking dismisses the box (poll: the locator detaches on dismiss).
		await vi.waitFor(() => {
			expect(screen.getByTestId('alfred-retry-box').elements().length).toBe(0)
		})
	})

	it('renders a rate-limit error with a snail countdown', async () => {
		const screen = await render(ChatTestHost, {
			credential: null,
			history: [
				{
					kind: 'event',
					seq: 1,
					type: 'error',
					payload: { error: 'Rate limited: wait 60 seconds then try again' },
					ts: 't',
				},
			],
		})
		await expect.element(screen.getByTestId('alfred-retry-box')).toBeVisible()
		await expect.element(screen.getByTestId('alfred-retry-countdown')).toBeVisible()
		await expect.element(screen.getByTestId('alfred-retry-box')).toHaveTextContent('🐌')
	})

	it('passes the picked combo-button mode to onsend', async () => {
		const encoder = new TextEncoder()
		const origFetch = globalThis.fetch
		// Hold the SSE stream open: steer/interrupt only exist while live.
		globalThis.fetch = (async (input: RequestInfo | URL, _init?: RequestInit) => {
			const url = String(input)
			if (url.includes('/streams/gen_1')) {
				const body = new ReadableStream({
					start(controller) {
						controller.enqueue(
							encoder.encode(
								`event: answer_delta\ndata: ${JSON.stringify({ stream_id: 'gen_1', stream_seq: 1, text: 'Hel' })}\n\n`
							)
						)
						// Never close — the generation stays live so the
						// queue/steer/interrupt modes are offered.
					},
				})
				return new Response(body, { status: 200 })
			}
			return Response.json({ ok: true })
		}) as unknown as typeof fetch
		try {
			const onsend = vi.fn(async (_prompt: string, _mode?: string) => null)
			const screen = await render(ChatTestHost, { credential: CRED, onsend })
			await screen.getByTestId('alfred-chat-mode-toggle').click()
			await screen.getByTestId('alfred-chat-mode-steer').click()
			const input = screen.getByTestId('alfred-chat-input')
			await input.fill('nudge')
			await screen.getByTestId('alfred-chat-send').click()
			await vi.waitFor(() => {
				expect(onsend).toHaveBeenCalledWith('nudge', 'steer')
			})
		} finally {
			globalThis.fetch = origFetch
		}
	})

	it('sends queue while live, prompt once the stream settles', async () => {
		const encoder = new TextEncoder()
		const origFetch = globalThis.fetch
		// Same held-open stream: plain Enter uses the live default `queue`.
		globalThis.fetch = (async (input: RequestInfo | URL, _init?: RequestInit) => {
			const url = String(input)
			if (url.includes('/streams/gen_1')) {
				const body = new ReadableStream({
					start(controller) {
						controller.enqueue(
							encoder.encode(
								`event: answer_delta\ndata: ${JSON.stringify({ stream_id: 'gen_1', stream_seq: 1, text: 'Hel' })}\n\n`
							)
						)
						// Never close — stays live.
					},
				})
				return new Response(body, { status: 200 })
			}
			return Response.json({ ok: true })
		}) as unknown as typeof fetch
		try {
			const onsend = vi.fn(async (_prompt: string, _mode?: string) => null)
			const screen = await render(ChatTestHost, { credential: CRED, onsend })
			await expect.element(screen.getByTestId('alfred-chat-send')).toHaveTextContent('queue')
			const input = screen.getByTestId('alfred-chat-input')
			await input.fill('follow-up')
			await screen.getByTestId('alfred-chat-send').click()
			await vi.waitFor(() => {
				expect(onsend).toHaveBeenCalledWith('follow-up', 'queue')
			})
		} finally {
			globalThis.fetch = origFetch
		}
	})

	it('offers prompt only when idle (no queue/steer/interrupt)', async () => {
		const screen = await render(ChatTestHost, {
			credential: null,
			history: [],
		})
		await expect.element(screen.getByTestId('alfred-chat-send')).toHaveTextContent('prompt')
		// Single valid mode → no dropdown toggle.
		await vi.waitFor(() => {
			expect(screen.getByTestId('alfred-chat-mode-toggle').elements().length).toBe(0)
		})
	})

	it('Stop button calls onstop', async () => {
		const encoder = new TextEncoder()
		const origFetch = globalThis.fetch
		// Hold the SSE stream open: the Stop button only shows while streaming.
		globalThis.fetch = (async (input: RequestInfo | URL, _init?: RequestInit) => {
			const url = String(input)
			if (url.includes('/streams/gen_1')) {
				const body = new ReadableStream({
					start(controller) {
						controller.enqueue(
							encoder.encode(
								`event: answer_delta\ndata: ${JSON.stringify({ stream_id: 'gen_1', stream_seq: 1, text: 'Hel' })}\n\n`
							)
						)
						// Never close — the component disposes it on Stop/unmount.
					},
				})
				return new Response(body, { status: 200 })
			}
			return Response.json({ ok: true })
		}) as unknown as typeof fetch
		try {
			const onstop = vi.fn()
			const screen = await render(ChatTestHost, { credential: CRED, onstop })
			await expect.element(screen.getByTestId('alfred-chat-stop')).toBeVisible()
			await screen.getByTestId('alfred-chat-stop').click()
			await vi.waitFor(() => {
				expect(onstop).toHaveBeenCalledTimes(1)
			})
		} finally {
			globalThis.fetch = origFetch
		}
	})

	it('renders translated composer + forwarded labels', async () => {
		const screen = await render(ChatTestHost, {
			credential: null,
			history: [],
			labels: {
				empty: 'Aucun message.',
				message: 'Message-fr',
				sending: 'Envoi…',
				sendMode: (m: string) => `Envoyer (${m})`,
				stop: 'Arrêter',
			},
			retryLabels: { keepRetry: 'Continuer', dismiss: 'Ignorer' },
			toolLabels: { arguments: 'Arguments-fr', output: 'Sortie' },
		})
		await expect
			.element(screen.getByTestId('alfred-chat-empty'))
			.toHaveTextContent('Aucun message.')
		await expect
			.element(screen.getByTestId('alfred-chat-send'))
			.toHaveTextContent('Envoyer (prompt)')
	})

	it('renders settled thoughts as a collapsed Thoughts row when showThought', async () => {
		const screen = await render(ChatTestHost, {
			credential: null,
			history: [{ kind: 'event', seq: 1, type: 'thought', payload: { text: 'hmm ok' }, ts: 't' }],
			showThought: true,
		})
		const row = screen.getByTestId('alfred-thought-row')
		await expect.element(row).toBeVisible()
		await expect.element(row).toHaveTextContent('Thoughts')
		await expect.element(screen.getByTestId('alfred-thought-settled')).toBeVisible()
		// Full text lives in the expandable details.
		await expect.element(row).toHaveTextContent('hmm ok')
	})

	it('hides thoughts unless showThought', async () => {
		const screen = await render(ChatTestHost, {
			credential: null,
			history: [{ kind: 'event', seq: 1, type: 'thought', payload: { text: 'hmm ok' }, ts: 't' }],
			showThought: false,
		})
		await expect.element(screen.getByTestId('alfred-chat-messages')).not.toHaveTextContent('hmm ok')
	})

	it('renders the streaming thought draft expanded when showThought', async () => {
		const encoder = new TextEncoder()
		const origFetch = globalThis.fetch
		// Hold the SSE stream open with a thought delta: live draft, no durable event yet.
		globalThis.fetch = (async (input: RequestInfo | URL, _init?: RequestInit) => {
			const url = String(input)
			if (url.includes('/streams/gen_1')) {
				const body = new ReadableStream({
					start(controller) {
						controller.enqueue(
							encoder.encode(
								`event: thought_delta\ndata: ${JSON.stringify({ type: 'thought_delta', stream_id: 'gen_1', stream_seq: 1, text: 'reasoning…' })}\n\n`
							)
						)
						// Never close — the draft stays live.
					},
				})
				return new Response(body, { status: 200 })
			}
			return Response.json({ ok: true })
		}) as unknown as typeof fetch
		try {
			const screen = await render(ChatTestHost, { credential: CRED, showThought: true })
			const live = screen.getByTestId('alfred-thought-live')
			await expect.element(live).toBeVisible()
			await expect.element(live).toHaveTextContent('reasoning…')
		} finally {
			globalThis.fetch = origFetch
		}
	})

	it('renders translated thought labels', async () => {
		const screen = await render(ChatTestHost, {
			credential: null,
			history: [{ kind: 'event', seq: 1, type: 'thought', payload: { text: 'hmm ok' }, ts: 't' }],
			showThought: true,
			thoughtLabels: { thoughts: 'Réflexions' },
		})
		await expect.element(screen.getByTestId('alfred-thought-row')).toHaveTextContent('Réflexions')
	})

	it('surfaces an onsend throw as role=alert and keeps the composer', async () => {
		const onsend = vi.fn(async () => {
			throw new Error('send failed (500)')
		})
		const screen = await render(ChatTestHost, { credential: null, history: [], onsend })
		await screen.getByTestId('alfred-chat-input').fill('boom')
		await screen.getByTestId('alfred-chat-send').click()
		await expect.element(screen.getByTestId('alfred-chat-error')).toBeVisible()
		await expect.element(screen.getByTestId('alfred-chat-error')).toHaveTextContent('send failed')
		// Composer is not a dead end.
		await expect.element(screen.getByTestId('alfred-chat-send')).toBeVisible()
	})

	it('surfaces a missing send handler as role=alert', async () => {
		const screen = await render(ChatTestHost, { credential: null, history: [], onsend: null })
		await screen.getByTestId('alfred-chat-input').fill('hello')
		await screen.getByTestId('alfred-chat-send').click()
		await expect.element(screen.getByTestId('alfred-chat-error')).toBeVisible()
		await expect
			.element(screen.getByTestId('alfred-chat-error'))
			.toHaveTextContent('no send handler')
	})

	it('refreshes the stream capability on 401 and retries the attach', async () => {
		const encoder = new TextEncoder()
		const calls: string[] = []
		const origFetch = globalThis.fetch
		const answer = `event: answer\ndata: ${JSON.stringify({ seq: 1, type: 'answer', payload: { text: 'recovered' }, ts: 't' })}\n\n`
		const done = `event: done\ndata: ${JSON.stringify({ seq: 2, type: 'done', payload: { reason: 'stop' }, ts: 't' })}\n\n`
		globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input)
			calls.push(url)
			const auth = new Headers(init?.headers).get('authorization')
			// Stale token → 401; refreshed token → the answer.
			if (auth !== 'Bearer fresh-tok') {
				return Response.json({ detail: 'expired' }, { status: 401 })
			}
			const body = new ReadableStream({
				start(controller) {
					controller.enqueue(encoder.encode(answer))
					controller.enqueue(encoder.encode(done))
					controller.close()
				},
			})
			return new Response(body, { status: 200 })
		}) as unknown as typeof fetch
		try {
			const refreshStream = vi.fn(async () => ({ ...CRED, stream_token: 'fresh-tok' }))
			const screen = await render(ChatTestHost, { credential: CRED, refreshStream })
			const messages = screen.getByTestId('alfred-chat-messages')
			await expect
				.element(messages.getByTestId('alfred-chat-message').first())
				.toHaveTextContent('recovered')
			expect(refreshStream).toHaveBeenCalledTimes(1)
			expect(calls.filter((u) => u.includes('/streams/gen_1')).length).toBe(2)
		} finally {
			globalThis.fetch = origFetch
		}
	})

	it('onretry returning a credential attaches a fresh generation (keepEvents)', async () => {
		const encoder = new TextEncoder()
		const origFetch = globalThis.fetch
		const first = `event: answer\ndata: ${JSON.stringify({ seq: 1, type: 'answer', payload: { text: 'partial work' }, ts: 't' })}\n\n`
		const terminal = `event: done\ndata: ${JSON.stringify({ seq: 2, type: 'done', payload: { reason: 'max_iterations' }, ts: 't' })}\n\n`
		const continued = `event: answer\ndata: ${JSON.stringify({ seq: 1, type: 'answer', payload: { text: 'continued' }, ts: 't' })}\n\n`
		const doneStop = `event: done\ndata: ${JSON.stringify({ seq: 2, type: 'done', payload: { reason: 'stop' }, ts: 't' })}\n\n`
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			const url = String(input)
			const body = new ReadableStream({
				start(controller) {
					if (url.includes('/streams/gen_2')) {
						controller.enqueue(encoder.encode(continued))
						controller.enqueue(encoder.encode(doneStop))
					} else {
						controller.enqueue(encoder.encode(first))
						controller.enqueue(encoder.encode(terminal))
					}
					controller.close()
				},
			})
			return new Response(body, { status: 200 })
		}) as unknown as typeof fetch
		try {
			const next: StreamCredential = {
				generation_id: 'gen_2',
				stream_token: 'tok-2',
				stream_url: 'http://localhost:8192/streams/gen_2',
			}
			const onretry = vi.fn(async (_msgId: string) => next)
			const screen = await render(ChatTestHost, { credential: CRED, onretry })
			await expect.element(screen.getByTestId('alfred-retry-box')).toBeVisible()
			await screen.getByTestId('alfred-retry-button').click()
			await vi.waitFor(() => {
				expect(onretry).toHaveBeenCalledTimes(1)
			})
			// Both turns render: the retry turnover keeps prior events.
			const messages = screen.getByTestId('alfred-chat-messages')
			await expect.element(messages).toHaveTextContent('partial work')
			await expect.element(messages).toHaveTextContent('continued')
		} finally {
			globalThis.fetch = origFetch
		}
	})
})
