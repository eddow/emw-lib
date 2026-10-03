/**
 * Workflow FE components (plan `plans/workflow-ui.md` §2 + §5.2).
 *
 * Covers: input form fields + required validation + urls splitting,
 * stream rows + parallel grid + stale banner + status, output `<dl>`
 * (record + wrapped string), pane phases (starting → running → done).
 */

import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-svelte'
import type { WorkflowStreamEvent } from './index.js'
import WorkflowTestHost from './WorkflowTestHost.svelte'

/* NOTE: every render uses { props: {...} } — the bare form misfires
 * whenever a prop is named `events` (a Svelte mount option): the testing
 * library then treats the object as mount options, drops the props, and
 * either renders empty or throws `UnknownSvelteOptionsError`. */

const FIELDS = [
	{ name: 'productDescription', type: 'textarea', required: true },
	{ name: 'marketplaces', type: 'urls', required: true },
] as const

function opened(idx: number, labelText: string): WorkflowStreamEvent {
	return {
		type: 'interaction_opened',
		idx,
		kind: 'tool',
		tool: 'serp_search',
		label: 's',
		label_text: labelText,
	}
}

function status(
	status: 'running' | 'waiting' | 'done' | 'error' | 'cancelled'
): WorkflowStreamEvent {
	return { type: 'run_status', status }
}

describe('WorkflowInputForm', () => {
	it('renders one control per field and submits collected input', async () => {
		expect.assertions(3)
		const onsubmit = vi.fn()
		const screen = await render(WorkflowTestHost, {
			props: {
				only: 'form',
				fields: [...FIELDS],
				onsubmit,
			},
		})
		await expect
			.element(screen.getByTestId('workflow-input-field-productDescription'))
			.toBeVisible()
		await screen
			.getByTestId('workflow-input-field-productDescription')
			.getByRole('textbox')
			.first()
			.fill('A widget')
		await screen
			.getByTestId('workflow-input-field-marketplaces')
			.getByRole('textbox')
			.first()
			.fill('emag.ro\nsupreva')
		await screen.getByTestId('workflow-input-submit').click()
		await vi.waitFor(() => {
			expect(onsubmit).toHaveBeenCalledWith({
				productDescription: 'A widget',
				marketplaces: ['emag.ro', 'supreva'],
			})
		})
		expect(onsubmit).toHaveBeenCalledTimes(1)
	})

	it('blocks submit on a missing required field', async () => {
		expect.assertions(2)
		const onsubmit = vi.fn()
		const screen = await render(WorkflowTestHost, {
			props: {
				only: 'form',
				fields: [...FIELDS],
				onsubmit,
			},
		})
		await screen.getByTestId('workflow-input-submit').click()
		await expect.element(screen.getByTestId('workflow-input-error')).toBeVisible()
		expect(onsubmit).not.toHaveBeenCalled()
	})
})

describe('WorkflowStream', () => {
	it('renders label_text rows and groups consecutive idxs in one line', async () => {
		expect.assertions(5)
		const screen = await render(WorkflowTestHost, {
			props: {
				events: [opened(0, 'Market step terms'), opened(1, 'Market step rank'), status('running')],
			},
		})
		const rows = screen.getByTestId('workflow-stream-row')
		await expect.element(rows.first()).toBeVisible()
		await expect
			.element(screen.getByTestId('workflow-stream-rows'))
			.toHaveTextContent('Market step terms')
		await expect
			.element(screen.getByTestId('workflow-stream-rows'))
			.toHaveTextContent('Market step rank')
		const lines = screen.getByTestId('workflow-stream-line')
		await expect.element(lines.first()).toBeVisible()
		await expect.element(screen.getByTestId('workflow-stream-status')).toHaveTextContent('Running')
	})

	it('splits non-consecutive idxs and shows the stale banner', async () => {
		expect.assertions(3)
		const screen = await render(WorkflowTestHost, {
			props: {
				events: [
					opened(0, 'one'),
					opened(2, 'two'),
					{ type: 'version_stale', deployment_url: 'https://old.example', opened_at: 't' },
					status('waiting'),
				],
			},
		})
		const lines = screen.getByTestId('workflow-stream-line')
		await expect.element(lines.first()).toBeVisible()
		await expect.element(screen.getByTestId('workflow-stream-rows')).toHaveTextContent('two')
		await expect.element(screen.getByTestId('workflow-stream-stale')).toBeVisible()
	})
})

describe('WorkflowOutput', () => {
	it('renders record W-O as a dl', async () => {
		expect.assertions(2)
		const screen = await render(WorkflowTestHost, {
			props: {
				only: 'output',
				output: { summary: 'Kept 2/3 pages.' },
			},
		})
		await expect.element(screen.getByTestId('workflow-output')).toBeVisible()
		await expect.element(screen.getByTestId('workflow-output-row')).toHaveTextContent('Kept 2/3')
	})

	it('wraps string W-O as Result', async () => {
		expect.assertions(1)
		const single = await render(WorkflowTestHost, {
			props: { only: 'output', output: 'findings' },
		})
		await expect.element(single.getByTestId('workflow-output-row')).toHaveTextContent('findings')
	})
})

describe('WorkflowPane', () => {
	it('shows the input form when starting', async () => {
		expect.assertions(1)
		const onstart = vi.fn()
		const start = await render(WorkflowTestHost, {
			props: {
				only: 'pane',
				phase: 'starting',
				fields: [...FIELDS],
				onstart,
			},
		})
		await expect.element(start.getByTestId('workflow-input-form')).toBeVisible()
	})

	it('shows the stream when running', async () => {
		expect.assertions(2)
		const running = await render(WorkflowTestHost, {
			props: {
				only: 'pane',
				phase: 'running',
				events: [opened(0, 'Market step terms'), status('running')],
				oncancel: vi.fn(),
			},
		})
		await expect.element(running.getByTestId('workflow-stream')).toBeVisible()
		await expect
			.element(running.getByTestId('workflow-stream-rows'))
			.toHaveTextContent('Market step terms')
	})

	it('shows the output when done', async () => {
		expect.assertions(1)
		const done = await render(WorkflowTestHost, {
			props: {
				only: 'pane',
				phase: 'done',
				events: [opened(0, 'Market step terms'), status('done')],
				output: { summary: 'Kept 2/3 pages.' },
			},
		})
		await expect.element(done.getByTestId('workflow-output')).toBeVisible()
	})

	it('pins the ask-human slot at the bottom while running', async () => {
		expect.assertions(2)
		const running = await render(WorkflowTestHost, {
			props: {
				only: 'pane',
				phase: 'running',
				events: [opened(0, 'Market step terms'), status('running')],
				showAskHuman: true,
				oncancel: vi.fn(),
			},
		})
		await expect.element(running.getByTestId('workflow-ask-human-pinned')).toBeVisible()
		await expect
			.element(running.getByTestId('workflow-ask-human-pinned'))
			.toHaveTextContent('Need your input')
	})

	it('forwards cancel and surfaces cancel errors', async () => {
		expect.assertions(3)
		const oncancel = vi.fn(async () => {
			throw new Error('cancel boom')
		})
		const running = await render(WorkflowTestHost, {
			props: {
				only: 'pane',
				phase: 'running',
				events: [opened(0, 'Market step terms'), status('running')],
				oncancel,
			},
		})
		await running.getByTestId('workflow-cancel').click()
		await expect.element(running.getByTestId('workflow-cancel-error')).toBeVisible()
		await expect
			.element(running.getByTestId('workflow-cancel-error'))
			.toHaveTextContent('cancel boom')
		expect(oncancel).toHaveBeenCalledTimes(1)
	})

	it('renders the error empty fallback when output is null', async () => {
		expect.assertions(2)
		const errored = await render(WorkflowTestHost, {
			props: {
				only: 'pane',
				phase: 'error',
				events: [opened(0, 'Market step terms'), status('error')],
			},
		})
		await expect.element(errored.getByTestId('workflow-output-empty')).toBeVisible()
		await expect.element(errored.getByTestId('workflow-output-empty')).toHaveTextContent('Error.')
	})

	it('renders the cancelled empty fallback when output is null', async () => {
		expect.assertions(2)
		const cancelled = await render(WorkflowTestHost, {
			props: {
				only: 'pane',
				phase: 'cancelled',
				events: [opened(0, 'Market step terms'), status('cancelled')],
			},
		})
		await expect.element(cancelled.getByTestId('workflow-output-empty')).toBeVisible()
		await expect
			.element(cancelled.getByTestId('workflow-output-empty'))
			.toHaveTextContent('Cancelled.')
	})

	it('renders the follow-up slot when done', async () => {
		expect.assertions(1)
		const done = await render(WorkflowTestHost, {
			props: {
				only: 'pane',
				phase: 'done',
				events: [opened(0, 'Market step terms'), status('done')],
				output: { summary: 'Kept 2/3 pages.' },
				showFollowUp: true,
			},
		})
		await expect.element(done.getByTestId('workflow-follow-up')).toBeVisible()
	})
})

describe('WorkflowStream reactivity', () => {
	it('picks up new events without a remount (host polls, no key needed)', async () => {
		expect.assertions(2)
		const screen = await render(WorkflowTestHost, {
			props: { events: [opened(0, 'first'), status('running')] },
		})
		await expect.element(screen.getByTestId('workflow-stream-rows')).toHaveTextContent('first')
		await screen.rerender({ events: [opened(0, 'first'), opened(1, 'second'), status('running')] })
		await expect.element(screen.getByTestId('workflow-stream-rows')).toHaveTextContent('second')
	})

	it('flips a row to settled on interaction_resolved', async () => {
		expect.assertions(2)
		const screen = await render(WorkflowTestHost, {
			props: {
				events: [
					opened(0, 'Market step terms'),
					{ type: 'interaction_resolved', idx: 0, status: 'resolved' },
					status('running'),
				],
			},
		})
		const row = screen.getByTestId('workflow-stream-row')
		await expect.element(row.first()).toBeVisible()
		await expect.element(row.first()).toHaveAttribute('data-status', 'resolved')
	})

	it('applies toolIcons and translated status labels', async () => {
		expect.assertions(2)
		const screen = await render(WorkflowTestHost, {
			props: {
				events: [opened(0, 'Market step terms'), status('running')],
				toolIcons: { serp_search: '🔍' },
				streamLabels: { running: 'En cours…' },
			},
		})
		await expect.element(screen.getByTestId('workflow-stream-rows')).toHaveTextContent('🔍')
		await expect
			.element(screen.getByTestId('workflow-stream-status'))
			.toHaveTextContent('En cours…')
	})

	it('shows working… from stream liveness (open row, no tick flag)', async () => {
		expect.assertions(2)
		const screen = await render(WorkflowTestHost, {
			props: { events: [opened(0, 'Market step terms'), status('running')] },
		})
		await expect.element(screen.getByTestId('workflow-working')).toBeVisible()
		await screen.rerender({
			events: [
				opened(0, 'Market step terms'),
				{ type: 'interaction_resolved', idx: 0, status: 'resolved' },
				status('done'),
			],
		})
		expect(screen.container.querySelector('[data-testid="workflow-working"]')).toBeNull()
	})

	it('renders a live draft under its open prompt row', async () => {
		expect.assertions(3)
		const screen = await render(WorkflowTestHost, {
			props: {
				events: [opened(0, 'Ranking results'), status('running')],
				drafts: { 0: 'draft text so far' },
			},
		})
		const draft = screen.getByTestId('workflow-prompt-draft')
		await expect.element(draft.first()).toBeVisible()
		await expect.element(draft.first()).toHaveTextContent('draft text so far')
		await expect.element(draft.first()).toHaveAttribute('data-idx', '0')
	})
})

describe('Workflow overrides', () => {
	it('form snippet replaces controls but submits through the same collection', async () => {
		expect.assertions(2)
		const onsubmit = vi.fn()
		const screen = await render(WorkflowTestHost, {
			props: {
				only: 'form',
				fields: [{ name: 'productDescription', type: 'text', required: true }],
				customForm: true,
				onsubmit,
			},
		})
		await expect.element(screen.getByTestId('workflow-input-custom')).toBeVisible()
		await screen.getByTestId('workflow-input-submit').click()
		await vi.waitFor(() => {
			expect(onsubmit).toHaveBeenCalledWith({ productDescription: 'hello-custom' })
		})
	})

	it('output snippet replaces the dl', async () => {
		expect.assertions(2)
		const screen = await render(WorkflowTestHost, {
			props: {
				only: 'output',
				output: { summary: 'Kept 2/3 pages.' },
				customOutput: true,
			},
		})
		await expect.element(screen.getByTestId('workflow-output-custom')).toBeVisible()
		expect(screen.container.querySelector('[data-testid="workflow-output"]')).toBeNull()
	})

	it('merges outputLabels over defLabels', async () => {
		expect.assertions(1)
		const screen = await render(WorkflowTestHost, {
			props: {
				only: 'output',
				output: { summary: 'Kept 2/3 pages.' },
				defLabels: { summary: 'Summary' },
				outputLabels: { summary: 'Résumé' },
			},
		})
		await expect.element(screen.getByTestId('workflow-output-row')).toHaveTextContent('Résumé')
	})

	it('uses inputLabels for field labels', async () => {
		expect.assertions(1)
		const screen = await render(WorkflowTestHost, {
			props: {
				only: 'form',
				fields: [...FIELDS],
				inputLabels: { productDescription: 'Produit' },
			},
		})
		await expect
			.element(screen.getByTestId('workflow-input-field-productDescription'))
			.toHaveTextContent('Produit')
	})
})
