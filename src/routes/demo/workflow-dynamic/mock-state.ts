/**
 * Scripted workflow journal for the `workflow-dynamic` e2e
 * (`workflow-dynamic.e2e.ts`). No Butler, no OpenRouter — deterministic.
 *
 * One run = `{ status, nextIdx, rows, askHuman, output, error }` where
 * `rows` are journal rows (`idx`, `kind`, `tool`, `label`, `label_text`,
 * `status`). The mock routes (`start`, `tick`, `stream`, `answer`,
 * `cancel`, `reset`) share this module-level state — same pattern as the
 * `chat-dynamic` mock (`vite preview` is ONE process).
 *
 * The script is fixed (mirrors `marketAnalysis` shape): `start` creates
 * the run with rows 0–1 already open (proves fast start + continuous
 * poll); each `tick` resolves the oldest open row and opens the next
 * scripted row, so rows appear one by one as the FE ticks. `answer`
 * resolves the `ask-human` row; `cancel` marks the run `cancelled`.
 *
 * Runs are keyed by fresh monotonic ids (never reused), so tests are
 * self-isolating WITHOUT clearing the map on reset (clearing mid-flight
 * deletes another worker's in-flight run — the parallel flake, same as
 * `chat-dynamic`). `resetAll` only clears failure arms.
 */

export interface MockRow {
	idx: number
	kind: 'prompt' | 'tool' | 'session'
	tool?: string
	label: string
	label_text: string
	status: 'open' | 'resolved' | 'failed'
}

export interface MockAskHuman {
	idx: number
	question: string
	options: string[]
	answer?: unknown
}

export interface MockRun {
	id: string
	status: 'running' | 'waiting' | 'done' | 'error' | 'cancelled'
	nextIdx: number
	rows: MockRow[]
	askHuman: MockAskHuman[]
	output: unknown
	error: string | null
	/** When set, `tick` returns this terminal status instead of advancing. */
	failMode: 'error' | null
	/** When set, the next `tick` sleeps ~400ms first (slow-tick path, W7). */
	held: boolean
	/**
	 * S7: run-local SSE event log (`{seq, type, payload}` wire shape, seq
	 * from 1). Every mutation appends here AND wakes the SSE waiters, so
	 * the mock mirrors S5's server reactivity: rows advance on
	 * `start`/`answer`/`cancel`/`fail` reactions, never on a browser tick.
	 */
	events: { seq: number; type: string; payload: Record<string, unknown> }[]
	/** Live SSE waiters (one per open `/wfstreams` connection). */
	waiters: (() => void)[]
}

const runs = new Map<string, MockRun>()
/** Monotonic id so every `start` gets a fresh run even across reloads. */
let nextN = 0

export function freshRunId(): string {
	nextN += 1
	return `run_e2e_${nextN}_${Date.now().toString(36)}`
}

function scriptRow(idx: number): Omit<MockRow, 'status'> {
	switch (idx) {
		case 0:
			return {
				idx,
				kind: 'session',
				label: 'session',
				label_text: 'Session opened',
			}
		case 1:
		case 2:
			// Consecutive idxs = one fan-out batch (W2: one grid line).
			return {
				idx,
				kind: 'tool',
				tool: 'serp_search',
				label: `serp ${idx}`,
				label_text: `Searching marketplace ${idx}`,
			}
		case 3:
			return {
				idx,
				kind: 'prompt',
				label: 'rank',
				label_text: 'Ranking results',
			}
		case 4:
			return {
				idx,
				kind: 'tool',
				tool: 'ask-human',
				label: 'ask-human',
				label_text: 'Need your input',
			}
		default:
			return {
				idx,
				kind: 'prompt',
				label: 'summary',
				label_text: `Summary step ${idx}`,
			}
	}
}

export function createMockRun(): MockRun {
	const id = freshRunId()
	const run: MockRun = {
		id,
		status: 'running',
		nextIdx: 2,
		rows: [
			{ ...scriptRow(0), status: 'resolved' },
			{ ...scriptRow(1), status: 'open' },
		],
		askHuman: [],
		output: null,
		error: null,
		failMode: null,
		held: false,
		events: [],
		waiters: [],
	}
	runs.set(id, run)
	// S7: seed rows publish their opens at creation (the `start` reaction),
	// so the SSE replay carries them — the page never polls.
	for (const row of run.rows) {
		publishMockEvent(run, 'interaction_opened', {
			idx: row.idx,
			kind: row.kind,
			...(row.tool ? { tool: row.tool } : {}),
			label: row.label,
			label_text: row.label_text,
		})
		if (row.status !== 'open') {
			publishMockEvent(run, 'interaction_resolved', { idx: row.idx, status: row.status })
		}
	}
	publishMockEvent(run, 'run_status', { status: run.status })
	return run
}

export function getMockRun(id: string): MockRun | undefined {
	return runs.get(id)
}

/**
 * S7: append one wire event (`{seq, type, payload}`, seq run-local from 1)
 * and wake every open `/wfstreams` connection. Every mutation below
 * publishes what it commits — the stream is eventually consistent with
 * the journal by construction (same rule as the real hosts' S4 publish).
 */
export function publishMockEvent(
	run: MockRun,
	type: string,
	payload: Record<string, unknown>
): { seq: number; type: string; payload: Record<string, unknown> } {
	const evt = { seq: run.events.length + 1, type, payload }
	run.events.push(evt)
	for (const w of run.waiters.splice(0)) w()
	return evt
}

/**
 * Advance one run: resolve the oldest open row, then open the next
 * scripted row (or finish). Returns the run's fresh status.
 */
export function tickMockRun(id: string): MockRun | undefined {
	const run = runs.get(id)
	if (!run) return undefined
	if (run.status === 'done' || run.status === 'error' || run.status === 'cancelled') return run
	if (run.failMode === 'error') {
		run.status = 'error'
		run.error = 'mock failure'
		publishMockEvent(run, 'run_status', { status: run.status })
		return run
	}
	const open = run.rows.find((r) => r.status === 'open')
	if (open) {
		open.status = 'resolved'
		if (open.tool === 'ask-human') {
			const q = run.askHuman.find((a) => a.idx === open.idx)
			if (q && q.answer === undefined) {
				// Answered via `/answer` (which resolves the row itself) —
				// a tick must not resolve an unanswered question.
				open.status = 'open'
				run.status = 'waiting'
				publishMockEvent(run, 'run_status', { status: run.status })
				return run
			}
		}
		publishMockEvent(run, 'interaction_resolved', { idx: open.idx, status: open.status })
	}
	if (run.nextIdx <= 5) {
		const next = scriptRow(run.nextIdx)
		run.rows.push({ ...next, status: 'open' })
		publishMockEvent(run, 'interaction_opened', {
			idx: next.idx,
			kind: next.kind,
			...(next.tool ? { tool: next.tool } : {}),
			label: next.label,
			label_text: next.label_text,
		})
		if (next.tool === 'ask-human') {
			// Same ask-human exception as the real hosts' `status` route:
			// question + options travel out-of-band (the journal
			// `input_json` never crosses the stream). The mock has no
			// journal, so the `status` route serves them from `askHuman`.
			run.askHuman.push({ idx: next.idx, question: 'Pick one?', options: ['a', 'b'] })
		}
		run.nextIdx += 1
		run.status = 'running'
		publishMockEvent(run, 'run_status', { status: run.status })
		return run
	}
	run.status = 'done'
	run.output = 'mock findings summary'
	publishMockEvent(run, 'run_status', { status: run.status })
	return run
}

export function answerMockRun(id: string, idx: number, answer: unknown): MockRun | null {
	const run = runs.get(id)
	if (!run) return null
	const row = run.rows.find((r) => r.idx === idx)
	if (!row || row.status !== 'open' || row.tool !== 'ask-human') return null
	row.status = 'resolved'
	const q = run.askHuman.find((a) => a.idx === idx)
	if (q) q.answer = answer
	// S7: the answer reaction resolves + publishes + re-ticks in one step
	// (mirrors the real hosts' S5 answer re-tick) — the browser never ticks.
	// The ask-human Q&A travels via the `status` route (same exception as
	// the real hosts: `input_json` never crosses the stream), so the pane
	// re-fetches it after the answer lands.
	publishMockEvent(run, 'interaction_resolved', { idx, status: 'resolved' })
	tickMockRun(id)
	return run
}

export function cancelMockRun(id: string): MockRun | undefined {
	const run = runs.get(id)
	if (!run) return undefined
	if (run.status === 'done' || run.status === 'error' || run.status === 'cancelled') return run
	run.status = 'cancelled'
	publishMockEvent(run, 'run_status', { status: run.status })
	return run
}

export function failMockRun(id: string): MockRun | undefined {
	const run = runs.get(id)
	if (!run) return undefined
	run.failMode = 'error'
	return run
}

/** Arm the next `tick` to sleep ~400ms first (slow-tick path, W7). */
export function holdMockRun(id: string): MockRun | undefined {
	const run = runs.get(id)
	if (!run) return undefined
	run.held = true
	return run
}

export function __mockWorkflowState() {
	return {
		runs,
		resetAll: () => {
			// Runs are keyed by fresh monotonic ids (never reused), so
			// tests are self-isolating WITHOUT clearing the map (same
			// rationale as `chat-dynamic` `mock-state.ts`).
		},
	}
}
