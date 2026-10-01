/* eslint-disable @typescript-eslint/no-explicit-any */
import { expect, type Page, test } from '@playwright/test'

/**
 * Dynamic-chat e2e (plan `plans/dynamic.md` §§3–5): `AlfredChat` wired to
 * the controllable mock SSE chatbot (`/demo/chat-dynamic/stream`,
 * driven via `POST /control`). No Butler, no OpenRouter.
 *
 * B1: idle prompt → answer renders spontaneously (no reload).
 * B2: live thought (expanded) → durable thought (collapsed one-liner).
 */

type Frame = Record<string, unknown>

async function emit(page: Page, frame: Frame): Promise<{ attached: boolean; queued: number }> {
	// Await the POST and return the server ack: `attached` proves the mock
	// stream reader was live (no pre-attach queue involved).
	const res = (await page.evaluate(
		(f) =>
			(window as unknown as { __mock: { emit: (x: unknown) => Promise<unknown> } }).__mock.emit(f),
		frame
	)) as unknown
	if (res instanceof Response) {
		return (await res.json()) as { attached: boolean; queued: number }
	}
	return res as { attached: boolean; queued: number }
}

test.describe('dynamic chat', () => {
	// Serial: repeats of one test share the preview server's module-level
	// `generations` map, and a `reset` racing an in-flight attach from the
	// previous repeat leaves the new generation unattached (`waitAttached`
	// times out). Serial execution keeps reset → goto → send → attach
	// strictly ordered (verified 54/54 with `--repeat-each=3 --workers=1`;
	// parallel workers flake ~8/54 on `waitAttached` alone).
	test.describe.configure({ mode: 'serial' })
	test.beforeEach(async ({ page }) => {
		// Isolate the mock server: `vite preview` is ONE process, so its
		// module-level `generations` map survives across tests. Reset it,
		// then load the page (which starts with `gen_e2e_0`, no stream).
		await page.request.post('/demo/chat-dynamic/reset')
		await page.goto('/demo/chat-dynamic')
	})

	/** Gate on the mock SSE reader being live (see B1): the first `emit()`
	 * must land on an attached controller, never in the pre-attach queue. */
	async function waitAttached(page: Page): Promise<void> {
		await expect
			.poll(async () => {
				const res = await page.request.get(
					`/demo/chat-dynamic/attached?gid=${await page.getByTestId('e2e-gid').getAttribute('data-gid')}`
				)
				return ((await res.json()) as { attached: boolean }).attached
			})
			.toBe(true)
	}

	test('B1: idle prompt streams the answer spontaneously', async ({ page }) => {
		await expect(page.getByTestId('alfred-chat-empty')).toBeVisible()

		await page.getByTestId('alfred-chat-input').fill('hello mock')
		await page.getByTestId('alfred-chat-send').click()
		await waitAttached(page)

		// Deltas render as a pending bubble with no reload.
		await emit(page, { kind: 'answer_delta', text: 'Hel' })
		await emit(page, { kind: 'answer_delta', text: 'lo' })
		const messages = page.getByTestId('alfred-chat-messages')
		await expect(messages.getByTestId('alfred-chat-message').last()).toContainText('Hello')

		// Durable final replaces the draft (no duplicate bubble), done settles.
		await emit(page, { kind: 'answer', text: 'Hello' })
		await emit(page, { kind: 'done', reason: 'stop' })
		await expect(messages.getByTestId('alfred-chat-message')).toHaveCount(1)
		await expect(messages).toContainText('Hello')
	})

	test('B2: live thought collapses to a one-liner when settled', async ({ page }) => {
		await page.getByTestId('alfred-chat-input').fill('think please')
		await page.getByTestId('alfred-chat-send').click()
		await waitAttached(page)

		await emit(page, { kind: 'thought_delta', text: 'hmm…' })
		await expect(page.getByTestId('alfred-thought-live')).toBeVisible()

		await emit(page, { kind: 'thought', text: 'hmm…' })
		await expect(page.getByTestId('alfred-thought-live')).toHaveCount(0)
		const settled = page.getByTestId('alfred-thought-settled')
		await expect(settled).toBeVisible()
		await expect(page.getByTestId('alfred-thought-row')).toHaveCount(1)

		await emit(page, { kind: 'answer', text: 'done' })
		await emit(page, { kind: 'done', reason: 'stop' })
		// The settled answer renders as its own bubble (the collapsed
		// thought one-liner shows only "Thoughts", not the answer text).
		await expect(page.getByTestId('alfred-chat-message').last()).toContainText('done')
	})

	test('tool_use pairs with tool_result into one collapsed row', async ({ page }) => {
		await page.getByTestId('alfred-chat-input').fill('search x')
		await page.getByTestId('alfred-chat-send').click()
		await waitAttached(page)

		await emit(page, { kind: 'tool_use', tool_call_id: 'c1', name: 'search', args: { q: 'x' } })
		const row = page.getByTestId('alfred-tool-call')
		await expect(row).toBeVisible()
		await expect(row).toHaveAttribute('data-pending', 'true')
		await expect(page.getByTestId('alfred-tool-live')).toBeVisible()

		await emit(page, {
			kind: 'tool_result',
			tool_call_id: 'c1',
			name: 'search',
			output: 'found it',
		})
		await expect(page.getByTestId('alfred-tool-live')).toHaveCount(0)
		await expect(page.getByTestId('alfred-tool-settled')).toBeVisible()
		await expect(row).toHaveAttribute('data-pending', 'false')

		await emit(page, { kind: 'answer', text: 'here: found it' })
		await emit(page, { kind: 'done', reason: 'stop' })
		await expect(page.getByTestId('alfred-chat-messages')).toContainText('here: found it')
	})

	test('queue/steer/interrupt stay on the same stream; stop aborts', async ({ page }) => {
		// Observe the wire: log every mock-stream GET (attach) with its gid.
		const streamGets: string[] = []
		page.on('request', (req) => {
			const url = req.url()
			if (url.includes('/demo/chat-dynamic/streams/') && req.method() === 'GET') {
				streamGets.push(url)
			}
		})
		await page.getByTestId('alfred-chat-input').fill('long task')
		await page.getByTestId('alfred-chat-send').click()
		await waitAttached(page)
		// First send resolves (prompt → new credential). The draft clears on
		// send, so the empty composer disables Send — refill to continue.
		await expect(page.getByTestId('e2e-sent-modes')).toHaveAttribute(
			'data-modes',
			/prompt:long task/
		)
		await expect(page.getByTestId('alfred-chat-input')).toHaveValue('')
		await emit(page, { kind: 'answer_delta', text: 'working…' })
		await expect(page.getByTestId('alfred-chat-message').last()).toContainText('working…')
		const attachesAfterPrompt = streamGets.length

		// Queue (plain Enter while live): same stream, no re-attach.
		await page.getByTestId('alfred-chat-input').fill('more context')
		await page.getByTestId('alfred-chat-send').click()
		await expect(page.getByTestId('e2e-sent-modes')).toHaveAttribute(
			'data-modes',
			/queue:more context/
		)
		await expect.poll(() => streamGets.length).toBe(attachesAfterPrompt)
		await emit(page, { kind: 'answer_delta', text: ' still' })
		await expect(page.getByTestId('alfred-chat-message').last()).toContainText('working… still')

		// Steer (Ctrl+Enter) and interrupt (Alt+Enter) likewise stay attached.
		await page.getByTestId('alfred-chat-input').fill('steer it')
		await page.getByTestId('alfred-chat-input').press('Control+Enter')
		await expect(page.getByTestId('e2e-sent-modes')).toHaveAttribute('data-modes', /steer:steer it/)
		await page.getByTestId('alfred-chat-input').fill('stop that')
		await page.getByTestId('alfred-chat-input').press('Alt+Enter')
		await expect(page.getByTestId('e2e-sent-modes')).toHaveAttribute(
			'data-modes',
			/interrupt:stop that/
		)

		// Esc stops: the loop aborts, the transcript is kept, the composer is usable.
		await page.keyboard.press('Escape')
		await expect(page.getByTestId('alfred-chat-input')).toBeEnabled()
	})

	test('error renders a retry box; stream failure keeps the composer', async ({ page }) => {
		await page.getByTestId('alfred-chat-input').fill('fail please')
		await page.getByTestId('alfred-chat-send').click()
		await waitAttached(page)
		await expect(page.getByTestId('e2e-sent-modes')).toHaveAttribute(
			'data-modes',
			/prompt:fail please/
		)

		await emit(page, { kind: 'error', error: 'boom' })
		await expect(page.getByTestId('alfred-retry-box')).toBeVisible()
		await expect(page.getByTestId('alfred-retry-box')).toContainText('boom')
		// Composer is not a dead end.
		await expect(page.getByTestId('alfred-chat-send')).toBeVisible()
	})

	test('S7 retry-continue: Keep/Try-again attaches a fresh generation', async ({ page }) => {
		await page.getByTestId('alfred-chat-input').fill('flaky task')
		await page.getByTestId('alfred-chat-send').click()
		await waitAttached(page)

		await emit(page, { kind: 'answer', text: 'partial work' })
		await emit(page, { kind: 'done', reason: 'max_iterations' })
		const box = page.getByTestId('alfred-retry-box')
		await expect(box).toBeVisible()
		await expect(box).toContainText('stopped early')

		// Keep/Try-again mints a fresh generation via `onretry` and attaches it.
		await page.getByTestId('alfred-retry-button').click()
		await waitAttached(page)
		await expect(page.getByTestId('e2e-retried')).not.toHaveAttribute('data-retried', '[]')
		await emit(page, { kind: 'answer_delta', text: 'continued…' })
		await expect(page.getByTestId('alfred-chat-message').last()).toContainText('continued…')
		await emit(page, { kind: 'answer', text: 'continued…' })
		await emit(page, { kind: 'done', reason: 'stop' })
		await expect(page.getByTestId('alfred-chat-messages')).toContainText('continued…')
	})

	test('S8 human QA: ask_human card posts the answer to Alfred directly', async ({ page }) => {
		await page.getByTestId('alfred-chat-input').fill('need a human')
		await page.getByTestId('alfred-chat-send').click()
		await waitAttached(page)

		await emit(page, { kind: 'human_question', tool_call_id: 'call_1' })
		const card = page.getByTestId('alfred-human-card')
		await expect(card).toBeVisible()
		// First option is the preferred default (marked selected).
		await expect(page.getByTestId('alfred-human-option').first()).toHaveAttribute(
			'data-selected',
			'true'
		)
		await page.getByTestId('alfred-human-submit').click()

		// The answer posts FE → Alfred direct (mock `answer` endpoint, no BE hop).
		const gid = await page.getByTestId('e2e-gid').getAttribute('data-gid')
		await expect
			.poll(async () => {
				const res = await page.request.get(`/demo/chat-dynamic/streams/${gid}/answers`)
				return (((await res.json()) as { answers: unknown[] }).answers ?? []).length
			})
			.toBe(1)
		const answersRes = await page.request.get(`/demo/chat-dynamic/streams/${gid}/answers`)
		const posted = (await answersRes.json()) as {
			answers: { toolCallId: string; body: { answers: { id: string; choice: string }[] } }[]
		}
		expect(posted.answers[0]?.toolCallId).toBe('call_1')
		expect(posted.answers[0]?.body.answers).toEqual([
			{ id: 'q', choice: 'a', autopicked: false, timed_out: false },
		])

		// The loop continues on the same stream after the answer.
		await emit(page, { kind: 'human_answer', tool_call_id: 'call_1' })
		await emit(page, { kind: 'answer', text: 'thanks, continuing' })
		await emit(page, { kind: 'done', reason: 'stop' })
		await expect(page.getByTestId('alfred-chat-messages')).toContainText('thanks, continuing')
	})

	test('rate-limit error shows the snail countdown', async ({ page }) => {
		await page.getByTestId('alfred-chat-input').fill('limited task')
		await page.getByTestId('alfred-chat-send').click()
		await waitAttached(page)

		await emit(page, { kind: 'error', error: 'Rate limited: wait 60 seconds then try again' })
		const box = page.getByTestId('alfred-retry-box')
		await expect(box).toBeVisible()
		await expect(box).toContainText('🐌')
		await expect(page.getByTestId('alfred-retry-countdown')).toBeVisible()
	})

	test('S9 history: reload renders durable turns with no live generation', async ({ page }) => {
		// The reload case is a host concern (APP `load` fetches `/history`),
		// but the transcript contract is e2e-visible: durable history renders
		// with `credential: null` (no stream) and the composer stays usable.
		// Covered at unit level by `Chat.svelte.test.ts` ("renders durable
		// history when no generation is live"); here we assert the live page
		// reaches the same state after its generation settles.
		await page.getByTestId('alfred-chat-input').fill('remember this')
		await page.getByTestId('alfred-chat-send').click()
		await waitAttached(page)
		await emit(page, { kind: 'answer', text: 'remembered' })
		await emit(page, { kind: 'done', reason: 'stop' })
		const messages = page.getByTestId('alfred-chat-messages')
		await expect(messages).toContainText('remembered')
		// Settled: no pending bubbles, composer idle and usable.
		await expect(page.getByTestId('alfred-thought-live')).toHaveCount(0)
		await page.getByTestId('alfred-chat-input').fill('follow-up')
		await expect(page.getByTestId('alfred-chat-send')).toBeEnabled()
	})

	test('multi-turn: second prompt keeps the first answer visible', async ({ page }) => {
		// Generation turnover must retain the transcript (keepEvents): the
		// first turn's durable `answer` stays rendered after the second
		// `prompt` attaches a fresh generation.
		await page.getByTestId('alfred-chat-input').fill('first question')
		await page.getByTestId('alfred-chat-send').click()
		await waitAttached(page)
		await emit(page, { kind: 'answer', text: 'first answer' })
		await emit(page, { kind: 'done', reason: 'stop' })
		const messages = page.getByTestId('alfred-chat-messages')
		await expect(messages).toContainText('first answer')

		await page.getByTestId('alfred-chat-input').fill('second question')
		await page.getByTestId('alfred-chat-send').click()
		await waitAttached(page)
		// The previous turn survives the turnover…
		await expect(messages).toContainText('first answer')
		await emit(page, { kind: 'answer_delta', text: 'second…' })
		await expect(page.getByTestId('alfred-chat-message').last()).toContainText('second…')
		await emit(page, { kind: 'answer', text: 'second answer' })
		await emit(page, { kind: 'done', reason: 'stop' })
		// …and both turns render once the second settles (no duplicates).
		await expect(messages).toContainText('first answer')
		await expect(messages).toContainText('second answer')
		await expect(messages.getByTestId('alfred-chat-message')).toHaveCount(2)
	})

	test('settled tool row expands args/output via <details>', async ({ page }) => {
		await page.getByTestId('alfred-chat-input').fill('search x')
		await page.getByTestId('alfred-chat-send').click()
		await waitAttached(page)
		await emit(page, { kind: 'tool_use', tool_call_id: 'c1', name: 'search', args: { q: 'x' } })
		await emit(page, { kind: 'tool_result', tool_call_id: 'c1', name: 'search', output: 'found it' })
		const settled = page.getByTestId('alfred-tool-settled')
		await expect(settled).toBeVisible()
		// Collapsed one-liner carries the summary; full args/output live
		// inside the expandable <details> (closed by default).
		await expect(settled).not.toHaveAttribute('open', '')
		await expect(settled).toContainText('search')
		await settled.locator('summary').click()
		await expect(settled).toHaveAttribute('open', '')
		await expect(settled).toContainText('found it')
		await emit(page, { kind: 'answer', text: 'ok' })
		await emit(page, { kind: 'done', reason: 'stop' })
	})

	test('settled thought expands full text via <details>', async ({ page }) => {
		await page.getByTestId('alfred-chat-input').fill('think please')
		await page.getByTestId('alfred-chat-send').click()
		await waitAttached(page)
		await emit(page, { kind: 'thought', text: 'deep reasoning here' })
		const settled = page.getByTestId('alfred-thought-settled')
		await expect(settled).toBeVisible()
		await expect(settled).not.toHaveAttribute('open', '')
		await settled.locator('summary').click()
		await expect(settled).toHaveAttribute('open', '')
		await expect(settled).toContainText('deep reasoning here')
		await emit(page, { kind: 'answer', text: 'ok' })
		await emit(page, { kind: 'done', reason: 'stop' })
	})

	test('superseded/archived render a status line, stop renders nothing', async ({ page }) => {
		// Terminal `done` closes the mock stream (mirrors Alfred), so each
		// reason needs its own generation — one `done` per stream.
		await page.getByTestId('alfred-chat-input').fill('status me')
		await page.getByTestId('alfred-chat-send').click()
		await waitAttached(page)
		await emit(page, { kind: 'done', reason: 'superseded' })
		await expect(page.getByTestId('alfred-status-line').first()).toBeVisible()
		await expect(page.getByTestId('alfred-chat-messages')).toContainText('Superseded')
		// No retry box for terminal status reasons.
		await expect(page.getByTestId('alfred-retry-box')).toHaveCount(0)

		await page.getByTestId('alfred-chat-input').fill('status again')
		await page.getByTestId('alfred-chat-send').click()
		await waitAttached(page)
		await emit(page, { kind: 'done', reason: 'archived' })
		await expect(page.getByTestId('alfred-chat-messages')).toContainText('archived')
		await expect(page.getByTestId('alfred-retry-box')).toHaveCount(0)

		// `stop` renders nothing — no status line for the third generation.
		await page.getByTestId('alfred-chat-input').fill('clean finish')
		await page.getByTestId('alfred-chat-send').click()
		await waitAttached(page)
		await emit(page, { kind: 'answer', text: 'all good' })
		await emit(page, { kind: 'done', reason: 'stop' })
		await expect(page.getByTestId('alfred-chat-messages')).toContainText('all good')
		await expect(page.getByTestId('alfred-status-line')).toHaveCount(2)
	})

	test('Stop button aborts the stream and keeps the transcript', async ({ page }) => {
		await page.getByTestId('alfred-chat-input').fill('long task')
		await page.getByTestId('alfred-chat-send').click()
		await waitAttached(page)
		await emit(page, { kind: 'answer_delta', text: 'working…' })
		await expect(page.getByTestId('alfred-chat-message').last()).toContainText('working…')
		// The Stop button shows only while streaming…
		await expect(page.getByTestId('alfred-chat-stop')).toBeVisible()
		await page.getByTestId('alfred-chat-stop').click()
		// …and the partial draft survives the abort; the composer is usable.
		await expect(page.getByTestId('alfred-chat-message').last()).toContainText('working…')
		await expect(page.getByTestId('alfred-chat-stop')).toHaveCount(0)
		await page.getByTestId('alfred-chat-input').fill('again')
		await expect(page.getByTestId('alfred-chat-send')).toBeEnabled()
	})

	test('attach failure surfaces an alert and keeps the composer', async ({ page }) => {
		// `failNext` answers the NEXT stream GET with an HTTP error: arm it
		// AFTER the composer is visible (so `window.__mock` exists) but
		// BEFORE the send whose attach must fail (the attach GET follows
		// `onsend` immediately). The failure surfaces as `role=alert` and
		// the composer stays usable.
		await page.getByTestId('alfred-chat-input').fill('doomed')
		await page.evaluate(() =>
			(window as unknown as { __mock: { failNext: (s: number, d: string) => unknown } }).__mock.failNext(
				410,
				'generation ended'
			)
		)
		await page.getByTestId('alfred-chat-send').click()
		await expect(page.getByTestId('alfred-chat-error')).toContainText('generation ended')
		await expect(page.getByTestId('alfred-chat-send')).toBeVisible()
	})

	test('assistant markdown renders bold + code', async ({ page }) => {
		await page.getByTestId('alfred-chat-input').fill('format me')
		await page.getByTestId('alfred-chat-send').click()
		await waitAttached(page)
		await emit(page, { kind: 'answer', text: '**bold** and `code`' })
		await emit(page, { kind: 'done', reason: 'stop' })
		const messages = page.getByTestId('alfred-chat-messages')
		await expect(messages.locator('strong')).toHaveText('bold')
		await expect(messages.locator('code')).toHaveText('code')
	})

	test('retry dismiss closes the box without a new generation', async ({ page }) => {
		await page.getByTestId('alfred-chat-input').fill('fail please')
		await page.getByTestId('alfred-chat-send').click()
		await waitAttached(page)
		await emit(page, { kind: 'error', error: 'boom' })
		await expect(page.getByTestId('alfred-retry-box')).toBeVisible()
		await page.getByTestId('alfred-retry-dismiss').click()
		await expect(page.getByTestId('alfred-retry-box')).toHaveCount(0)
		// Dismiss is local: no retry generation was minted.
		await expect(page.getByTestId('e2e-retried')).toHaveAttribute('data-retried', '[]')
	})

	test('mode dropdown offers queue/steer/interrupt while live', async ({ page }) => {
		await page.getByTestId('alfred-chat-input').fill('long task')
		await page.getByTestId('alfred-chat-send').click()
		await waitAttached(page)
		// Live → the ▾ toggle appears with the three live modes…
		await expect(page.getByTestId('alfred-chat-mode-toggle')).toBeVisible()
		await page.getByTestId('alfred-chat-mode-toggle').click()
		await expect(page.getByTestId('alfred-chat-modes')).toBeVisible()
		await expect(page.getByTestId('alfred-chat-mode-queue')).toBeVisible()
		await expect(page.getByTestId('alfred-chat-mode-steer')).toBeVisible()
		await expect(page.getByTestId('alfred-chat-mode-interrupt')).toBeVisible()
		// …picking steer routes the next send through `steer`.
		await page.getByTestId('alfred-chat-mode-steer').click()
		await page.getByTestId('alfred-chat-input').fill('nudge')
		await page.getByTestId('alfred-chat-send').click()
		await expect(page.getByTestId('e2e-sent-modes')).toHaveAttribute('data-modes', /steer:nudge/)
		await emit(page, { kind: 'done', reason: 'stop' })
	})
})
