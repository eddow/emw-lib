/**
 * End-to-end workflow run with mocked "own workflow" tools
 * (checklist 8.2 — result-level proof beside the unit battery).
 *
 * Tools resolve predictably after a `setTimeout(100)` delay (real async
 * promise resolution, not manual `output_json` stuffing): each `waiting`
 * tick's fresh opens are executed through `toolImpls` and written back
 * as `resolved` rows, then the next tick replays past them. After every
 * tick the test snapshots the cache (`rows`, `memos`, `next_index`) so a
 * reader can see exactly how the journal grows.
 */

import { describe, expect, it } from 'vitest'
import { installSentinelRejectionGuard, type TickResult, tick } from './driver.js'
import type { ToolRegistry, WFContext } from './index.js'
import type { WorkflowInteractionRow, WorkflowRunRow } from './journal.js'

/** Same in-memory journal fake as `driver.test.ts` (rows + memos + run). */
function fakeDb(opts: {
	run: Partial<WorkflowRunRow> & { id: string }
	rows?: WorkflowInteractionRow[]
}) {
	const queries: string[] = []
	const rows = new Map<number, WorkflowInteractionRow>()
	for (const r of opts.rows ?? []) rows.set(r.idx, { ...r })
	const memos = new Map<
		string,
		{ run_id: string; key: string; fn_hash: string; output_json: unknown; created_at: string }
	>()
	const run = {
		workflow_name: 'calcWorkflow',
		workflow_version: 1,
		input_json: { a: 1, b: 2 },
		deployment_url: 'https://x.vercel.app',
		prod_deployment_url: '',
		status: 'running',
		next_index: opts.rows?.length ?? 0,
		return_json: null,
		error: null,
		opens_used: 0,
		bytes_used: 0,
		tick: 0,
		...opts.run,
	} as WorkflowRunRow
	const sql = Object.assign(
		async (strings: TemplateStringsArray, ...vals: unknown[]) => {
			const text = strings.join(' ').replace(/\s+/g, ' ').trim()
			queries.push(text)
			if (text.startsWith('SELECT id, workflow_name')) return [{ ...run }]
			if (text.includes('FROM workflow_interactions')) {
				return [...rows.values()].sort((a, b) => a.idx - b.idx)
			}
			if (text.includes('FROM workflow_memos')) {
				const [runId, key] = vals as [string, string]
				void runId
				const found = [...memos.values()].find((m) => m.key === key)
				return found ? [{ ...found }] : []
			}
			if (text.includes('INSERT INTO workflow_memos')) {
				const [runId, key, fnHash, outputJson] = vals as [string, string, string, string]
				const existing = memos.get(key)
				if (!existing) {
					const memoRow = {
						run_id: runId,
						key,
						fn_hash: fnHash,
						output_json: JSON.parse(outputJson as string),
						created_at: '',
					}
					memos.set(key, memoRow)
					return [{ ...memoRow }]
				}
				return []
			}
			if (text.startsWith('UPDATE workflow_interactions')) {
				if (text.includes('SET session_id =') && vals.length === 3) {
					const [sessionId, , idx] = vals as [string, string, number]
					const existing = rows.get(idx)
					if (existing) existing.session_id = sessionId
				}
				if (text.includes('SET status =') && text.includes('RETURNING id, run_id')) {
					const [status, outputJson, error, , idx] = vals as [
						string,
						string | null,
						string | null,
						string,
						number,
					]
					const existing = rows.get(idx)
					if (existing && existing.status === 'open') {
						existing.status = status as WorkflowInteractionRow['status']
						existing.output_json = outputJson ? JSON.parse(outputJson) : null
						existing.error = error
						return [{ ...existing }]
					}
					return []
				}
				return []
			}
			if (text.startsWith('UPDATE workflow_runs')) {
				if (text.includes("status = 'error'")) run.status = 'error'
				if (text.includes("status = 'done'")) {
					run.status = 'done'
					const rv = vals.find((v) => typeof v === 'string')
					if (rv !== undefined) {
						try {
							run.return_json = JSON.parse(rv as string)
						} catch {
							run.return_json = rv
						}
					}
				}
				if (text.includes("status = 'waiting'")) run.status = 'waiting'
				return []
			}
			return []
		},
		{
			transaction: async (fn: (txn: unknown) => unknown[]) => {
				const txn = (async (strings: TemplateStringsArray, ...vals: unknown[]) => {
					const text = strings.join(' ').replace(/\s+/g, ' ').trim()
					queries.push(`TXN: ${text}`)
					if (text.includes('INSERT INTO workflow_interactions')) {
						const [, idx, kind, label, labelText, tool, inputJson] = vals
						const row = {
							id: rows.size + 1,
							run_id: run.id,
							idx: idx as number,
							kind,
							label,
							label_text: labelText,
							tool,
							input_json: JSON.parse(inputJson as string),
							status: 'open',
							output_json: null,
							error: null,
							session_id: null,
							toolset_json: null,
							expires_at: null,
						} as WorkflowInteractionRow
						rows.set(idx as number, row)
						run.next_index = (idx as number) + 1
						return [row]
					}
					if (text.includes('UPDATE workflow_runs')) {
						return [{ id: run.id }]
					}
					return []
				}) as unknown
				const out: unknown[] = []
				for (const stmt of fn(txn)) out.push(await stmt)
				return out
			},
		}
	)
	return {
		sql: sql as unknown as import('./journal.js').WorkflowSql,
		queries,
		run,
		rows,
		memos,
	}
}

type Db = ReturnType<typeof fakeDb>

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------------------
// Mocked "own workflow" tools: predictable values, real async resolution.
// ---------------------------------------------------------------------------

type CalcRegistry = ToolRegistry & {
	add: { input: { a: number; b: number }; output: number }
	mul: { input: { a: number; b: number }; output: number }
}

const toolImpls = {
	add: async ({ a, b }: { a: number; b: number }) => {
		await delay(100)
		return a + b
	},
	mul: async ({ a, b }: { a: number; b: number }) => {
		await delay(100)
		return a * b
	},
}

let onceCalls = 0

async function calcWorkflow(
	{ createSession, all, use, once }: WFContext<CalcRegistry>,
	input: { a: number; b: number }
): Promise<{ sum: number; prod: number; verdict: string; doubled: number[]; stamp: number }> {
	const sum = await use.add({ a: input.a, b: input.b }) // 1+2 = 3
	const prod = await use.mul({ a: sum, b: input.b }) // 3*2 = 6
	const session = await createSession({
		model: 'm',
		systemPrompt: 'p',
		initialPrompt: 'hi',
	})
	const verdict = await session.prompt('verdict', `sum=${sum} prod=${prod}`)
	const doubled = await all([use.add({ a: prod, b: prod }), use.add({ a: sum, b: sum })])
	const stamp = once('stamp', () => {
		onceCalls++
		return 7
	})
	return { sum, prod, verdict, doubled, stamp }
}

/** Cache snapshot after a tick: what the journal holds right now. */
function snapshot(db: Db) {
	return {
		next_index: db.run.next_index,
		rows: [...db.rows.values()]
			.sort((a, b) => a.idx - b.idx)
			.map((r) => ({
				idx: r.idx,
				kind: r.kind,
				tool: r.tool,
				label: r.label,
				status: r.status,
				input: r.input_json,
				output: r.output_json,
			})),
		memos: [...db.memos.entries()].map(([k, m]) => ({ key: k, output: m.output_json })),
	}
}

/**
 * Drive a run to terminal, resolving each `waiting` tick's fresh opens
 * through the mocked tool impls (100ms async) / canned prompt answers.
 * Returns the terminal result plus one snapshot per tick.
 */
async function runToDone(
	db: Db,
	workflowFn: (wf: WFContext<CalcRegistry>, input: { a: number; b: number }) => Promise<unknown>
): Promise<{ final: TickResult; snaps: ReturnType<typeof snapshot>[] }> {
	const snaps: ReturnType<typeof snapshot>[] = []
	for (let t = 0; t < 12; t++) {
		const res = await tick('r-1', {
			sql: db.sql,
			postSession: async () => 'sess-1',
			workflowFn: workflowFn as (wf: WFContext<ToolRegistry>, input: unknown) => Promise<unknown>,
		})
		snaps.push(snapshot(db))
		// Resolve what this tick opened (session rows stay `open` for life).
		for (const o of res.opened) {
			const row = db.rows.get(o.idx)
			if (!row || row.status !== 'open') continue
			if (o.kind === 'session') continue
			if (o.kind === 'tool') {
				const impl = toolImpls[row.tool as keyof typeof toolImpls]
				const out = await impl(row.input_json as { a: number; b: number })
				row.status = 'resolved'
				row.output_json = out
			} else if (o.kind === 'prompt') {
				row.status = 'resolved'
				row.output_json = `verdict: sum=3 prod=6 ok`
			}
		}
		if (res.status === 'done' || res.status === 'error') return { final: res, snaps }
	}
	throw new Error('run did not reach a terminal state in 12 ticks')
}

describe('mocked-tool runthrough (8.2 result proof)', () => {
	it('calcWorkflow runs to done; journal grows one idx per open, memo replays', async () => {
		expect.assertions(14)
		onceCalls = 0
		const uninstall = installSentinelRejectionGuard()
		try {
			const db = fakeDb({ run: { id: 'r-1', next_index: 0 } })
			const { final, snaps } = await runToDone(db, calcWorkflow)

			// Terminal result: the mocked tools' predictable values flow through.
			expect(final.status).toBe('done')
			expect(final.returnValue).toEqual({
				sum: 3,
				prod: 6,
				verdict: 'verdict: sum=3 prod=6 ok',
				doubled: [12, 6],
				stamp: 7,
			})

			// Cache shape: 1 session + 2 serial tools + 1 prompt + 2 fan-out
			// tools = 6 idxs, consumed in order, never reused.
			expect(db.run.next_index).toBe(6)
			expect(snaps.length).toBeGreaterThan(1)
			const last = snaps[snaps.length - 1]
			expect(last.rows).toHaveLength(6)
			expect(last.rows.map((r) => r.kind)).toEqual([
				'tool',
				'tool',
				'session',
				'prompt',
				'tool',
				'tool',
			])
			// Session row stays `open` (live handle); everything else resolved.
			expect(last.rows.filter((r) => r.status === 'resolved')).toHaveLength(5)
			expect(last.rows.find((r) => r.kind === 'session')?.status).toBe('open')

			// Memo: `once('stamp')` ran exactly once, journaled under its key.
			expect(onceCalls).toBe(1)
			expect(last.memos).toEqual([{ key: 'stamp', output: 7 }])

			// Replay stability: a further tick on the `done` run returns the
			// stored W-O without re-executing (no new opens, no extra calls).
			const again = await tick('r-1', {
				sql: db.sql,
				postSession: async () => 'sess-1',
				workflowFn: calcWorkflow as unknown as (
					wf: WFContext<ToolRegistry>,
					input: unknown
				) => Promise<unknown>,
			})
			expect(again.status).toBe('done')
			expect(again.returnValue).toEqual(final.returnValue)
			expect(again.opened).toHaveLength(0)
			expect(onceCalls).toBe(1)
		} finally {
			uninstall()
		}
	})

	it('per-tick snapshots show one new open per suspend (no skipped idx)', async () => {
		expect.assertions(5)
		const uninstall = installSentinelRejectionGuard()
		try {
			const db = fakeDb({ run: { id: 'r-1', next_index: 0 } })
			const { snaps } = await runToDone(db, calcWorkflow)
			// Each waiting tick commits ≥1 new row; idxs are dense 0..N-1.
			const idxs = snaps[snaps.length - 1].rows.map((r) => r.idx)
			expect(idxs).toEqual([0, 1, 2, 3, 4, 5])
			for (let i = 1; i < snaps.length - 1; i++) {
				expect(snaps[i].rows.length).toBeGreaterThanOrEqual(snaps[i - 1].rows.length)
			}
		} finally {
			uninstall()
		}
	})
})
