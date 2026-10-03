import { expect, type Page, test } from '@playwright/test'

/**
 * Workflow-dynamic e2e (plan `plans/workflow-finalize.md` §6 S7):
 * `WorkflowPane` wired to the scripted mock routes
 * (`/demo/workflow-dynamic/...`), driven via `window.__wf`. No Butler,
 * no OpenRouter — deterministic.
 *
 * S7 transport: one `WorkflowRunStream` SSE attach over the mock
 * `/wfstreams` route. The mock advances rows on `start`/`answer`/
 * `cancel`/`fail` reactions (server-side harness hooks — S5
 * reactivity); the page only watches. `__wf.tick()` = one scripted
 * step (kept as the e2e clock name); the SSE replay delivers it.
 *
 * W1: start → pane mounts immediately → rows appear one by one (SSE).
 * W2: fan-out batch (idx 1+2) renders as one parallel grid line.
 * W3: ask-human → pinned card → answer → row resolves → run continues.
 * W4: terminal `done` → output renders; `error` → error text renders.
 * W5: reload mid-run → journal-derived seed renders, SSE re-attaches (no duplicate rows).
 * W6: cancel → terminal `cancelled`.
 * W7: stream-derived working indicator visible while rows are open, gone at `done`.
 */

async function wf(page: Page, expr: string): Promise<unknown> {
	return page.evaluate(`window.__wf.${expr}`)
}

async function startRun(page: Page): Promise<string> {
	await page
		.getByTestId('workflow-input-field-productDescription')
		.locator('textarea')
		.fill('e2e product')
	await page.getByTestId('workflow-input-submit').click()
	await expect(page.getByTestId('e2e-run-id')).not.toHaveAttribute('data-run', '')
	const runId = (await page.getByTestId('e2e-run-id').getAttribute('data-run')) ?? ''
	expect(runId).not.toBe('')
	// The run id persists in `?run=` so a reload re-attaches (W5).
	await expect.poll(async () => new URL(page.url()).searchParams.get('run')).toBe(runId)
	return runId
}

async function waitForWf(page: Page): Promise<void> {
	await expect.poll(async () => page.evaluate(`typeof window.__wf !== 'undefined'`)).toBe(true)
}

test.describe('workflow dynamic', () => {
	test.beforeEach(async ({ page }) => {
		await page.request.post('/demo/workflow-dynamic/reset')
		await page.goto('/demo/workflow-dynamic')
		// Manual clock: the e2e drives `tick()` on command, so rows
		// appear deterministically (no auto-tick races). `__wf` is
		// installed by the page `$effect` — wait for it first.
		await waitForWf(page)
	})

	test('W1: start mounts immediately, rows appear one by one', async ({ page }) => {
		await expect(page.getByTestId('workflow-input-form')).toBeVisible()
		// Fast start: `start` returns without ticking, so the pane leaves
		// `starting` within ~1s (no 60s freeze — the D1 regression).
		const t0 = Date.now()
		const runId = await startRun(page)
		expect(runId).not.toBe('')
		await expect(page.getByTestId('workflow-pane')).toHaveAttribute('data-phase', 'running')
		expect(Date.now() - t0).toBeLessThan(5000)
		// First rows arrive via the SSE replay (seed rows 0–1).
		await expect(page.getByTestId('workflow-stream-row')).toHaveCount(2)
		// One scripted step resolves row 1 and opens row 2 (SSE live).
		await wf(page, 'tick()')
		await expect(page.getByTestId('workflow-stream-row')).toHaveCount(3)
	})

	test('W2: fan-out batch renders as one parallel grid line', async ({ page }) => {
		await startRun(page)
		await expect(page.getByTestId('workflow-stream-row')).toHaveCount(2)
		await wf(page, 'tick()')
		// Rows 0–2 are consecutive idxs → one parallel line, three rows.
		const lines = page.getByTestId('workflow-stream-line')
		await expect(lines).toHaveCount(1)
		await expect(lines.nth(0)).toHaveAttribute('data-parallel', 'true')
		await expect(lines.nth(0).getByTestId('workflow-stream-row')).toHaveCount(3)
	})

	test('W3: ask-human pins, answers, and the run continues', async ({ page }) => {
		await startRun(page)
		// Advance to the ask-human row (idx 4): ticks open 2, 3, 4.
		await wf(page, 'tick()')
		await wf(page, 'tick()')
		await wf(page, 'tick()')
		await expect(page.getByTestId('wf-answer-a')).toBeVisible()
		await page.getByTestId('wf-answer-a').click()
		// Answered: the pinned card disappears, the row resolves (the
		// answer reaction re-ticks server-side and publishes — SSE live).
		await expect(page.getByTestId('wf-answer-a')).toHaveCount(0)
		await expect(page.getByTestId('workflow-stream-row')).toHaveCount(6)
	})

	test('W4: done renders output, error renders error text', async ({ page }) => {
		await startRun(page)
		// Answer the ask-human row so the run can finish (the answer
		// reaction re-ticks past it server-side).
		await wf(page, 'tick()')
		await wf(page, 'tick()')
		await wf(page, 'tick()')
		await page.getByTestId('wf-answer-a').click()
		await wf(page, 'tick()')
		await expect(page.getByTestId('workflow-output')).toContainText('mock findings summary')

		// Fresh run, armed to fail: error text renders.
		await page.goto('/demo/workflow-dynamic')
		await waitForWf(page)
		await startRun(page)
		await wf(page, 'fail()')
		await wf(page, 'tick()')
		await expect(page.getByTestId('workflow-output-empty')).toContainText('mock failure')
	})

	test('W5: reload mid-run re-attaches with no duplicate rows', async ({ page }) => {
		const runId = await startRun(page)
		await wf(page, 'tick()')
		const before = await page.getByTestId('workflow-stream-row').count()
		expect(before).toBe(3)
		const textsBefore = await page.getByTestId('workflow-stream-text').allTextContents()
		// The mock journal survives reload (module-level state); `?run=`
		// survives too, so the page re-seeds from the journal and
		// re-attaches SSE from `after_seq=0` — same rows, no duplicates.
		await page.reload()
		await waitForWf(page)
		await expect(page.getByTestId('e2e-run-id')).toHaveAttribute('data-run', runId)
		await expect(page.getByTestId('workflow-pane')).toHaveAttribute('data-phase', 'running')
		await expect(page.getByTestId('workflow-stream-row')).toHaveCount(3)
		await expect(page.getByTestId('workflow-stream-text').allTextContents()).resolves.toEqual(
			textsBefore
		)
		// The SSE loop continues from the tail: one more step grows the rows.
		await wf(page, 'tick()')
		await expect(page.getByTestId('workflow-stream-row')).toHaveCount(4)
	})

	test('W6: cancel reaches cancelled', async ({ page }) => {
		await startRun(page)
		await page.getByTestId('workflow-cancel').click()
		await expect(page.getByTestId('workflow-pane')).toHaveAttribute('data-phase', 'cancelled')
		await expect(page.getByTestId('workflow-output-empty')).toContainText('Cancelled')
	})

	test('W7: working indicator is stream-derived (open rows), gone at done', async ({ page }) => {
		await startRun(page)
		await expect(page.getByTestId('workflow-stream-row')).toHaveCount(2)
		// S7 liveness: "working…" shows while the run is non-terminal and
		// any row is open — no tick timer involved.
		await expect(page.getByTestId('workflow-working')).toBeVisible()
		// Drive to `done` (answer the ask-human row on the way); the
		// terminal `run_status` disposes the stream and the indicator goes.
		await wf(page, 'tick()')
		await wf(page, 'tick()')
		await wf(page, 'tick()')
		await page.getByTestId('wf-answer-a').click()
		await wf(page, 'tick()')
		await expect(page.getByTestId('workflow-output')).toContainText('mock findings summary')
		await expect(page.getByTestId('workflow-working')).toHaveCount(0)
	})
})
