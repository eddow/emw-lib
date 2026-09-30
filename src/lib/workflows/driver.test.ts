import { describe, expect, it } from 'vitest'
import {
	collectOutcome,
	hasControlFlowOutcome,
	installSentinelRejectionGuard,
	tick,
} from './driver'
import type { ToolRegistry, WFContext } from './index.js'
import { InteractionFailed } from './index.js'
import type { WorkflowInteractionRow, WorkflowRunRow } from './journal'

/** In-memory journal fake: rows keyed by (run_id, idx). */
function fakeDb(opts: {
	run: Partial<WorkflowRunRow> & { id: string }
	rows?: WorkflowInteractionRow[]
	postSession?: (input: unknown) => Promise<string>
}) {
	const queries: string[] = []
	const rows = new Map<number, WorkflowInteractionRow>()
	for (const r of opts.rows ?? []) rows.set(r.idx, { ...r })
	const memos = new Map<
		string,
		{ run_id: string; key: string; fn_hash: string; output_json: unknown; created_at: string }
	>()
	const run = {
		workflow_name: 'w',
		workflow_version: 1,
		input_json: {},
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
				// resolveExpiries flip (no-op: fake rows never expire),
				// session POST-failure mark / session_id write-back,
				// resolveInteraction (R5) / pre-fixed ask-human resolve.
				// Session write-back: [sessionId, runId, idx].
				if (text.includes('SET session_id =') && vals.length === 3) {
					const [sessionId, , idx] = vals as [string, string, number]
					const existing = rows.get(idx)
					if (existing) existing.session_id = sessionId
				}
				// resolveInteraction: [status, outputJson|null, error|null, runId, idx].
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
				// cancelRun interactions flip (workflow_interactions).
				if (text.includes("SET status = 'cancelled'")) {
					let n = 0
					for (const r of rows.values()) {
						if (r.status === 'open') {
							r.status = 'cancelled'
							n++
						}
					}
					return Array.from({ length: n }, (_, i) => ({ id: i + 1 }))
				}
				return []
			}
			if (text.startsWith('UPDATE workflow_runs')) {
				if (text.includes("status = 'error'")) {
					run.status = 'error'
					const m = text.match(/error = /)
					void m
				}
				if (text.includes("status = 'done'")) {
					run.status = 'done'
					// Capture the persisted return value like a real DB:
					// the interpolated value is already a JSON string.
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
				// cancelRun run-guard UPDATE (active-only): flips the run
				// when still active, no-op on terminal runs.
				if (text.includes("status = 'cancelled'")) {
					if (run.status === 'running' || run.status === 'waiting') {
						run.status = 'cancelled'
						return [{ id: run.id }]
					}
					return []
				}
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
						// Recover kind/label/tool/input from the interpolated
						// values: [runId, idx, kind, label, labelText, tool,
						// inputJson, sessionId, toolsetJson, expiresAt].
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
						run.next_index += 0
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

function row(
	idx: number,
	over: Partial<WorkflowInteractionRow> & { kind: WorkflowInteractionRow['kind'] }
): WorkflowInteractionRow {
	return {
		id: idx + 1,
		run_id: 'r-1',
		idx,
		label: 'tool',
		label_text: 'tool',
		tool: 'tool',
		input_json: { q: 1 },
		status: 'resolved',
		output_json: null,
		error: null,
		session_id: null,
		toolset_json: null,
		expires_at: null,
		created_at: '',
		updated_at: '',
		...over,
	}
}

describe('tick §3.1 paths', () => {
	it('pure workflow persists done with the return value', async () => {
		expect.assertions(3)
		const db = fakeDb({ run: { id: 'r-1', next_index: 0 } })
		const res = await tick('r-1', {
			sql: db.sql,
			workflowFn: async () => 'hello',
		})
		expect(res.status).toBe('done')
		expect(res.returnValue).toBe('hello')
		expect(db.run.status).toBe('done')
	})

	it('registry lookup resolves name@version; missing registration throws (7.x)', async () => {
		expect.assertions(3)
		const db = fakeDb({
			run: { id: 'r-1', next_index: 0, workflow_name: 'w', workflow_version: 2 },
		})
		const res = await tick('r-1', {
			sql: db.sql,
			lookupWorkflow: (name, version) => {
				expect(`${name}@${version}`).toBe('w@2')
				return { fn: async () => 'via-registry' }
			},
		})
		expect(res.status).toBe('done')
		expect(res.returnValue).toBe('via-registry')
	})

	it('missing registration is a hard throw (never silent wrong-code replay)', async () => {
		expect.assertions(1)
		const db = fakeDb({ run: { id: 'r-1', next_index: 0 } })
		await expect(tick('r-1', { sql: db.sql, lookupWorkflow: () => undefined })).rejects.toThrow(
			'workflow not registered'
		)
	})

	it('W-O mismatch is output_mismatch, never coerced done (9.2)', async () => {
		expect.assertions(3)
		const db = fakeDb({ run: { id: 'r-1', next_index: 0 } })
		const stringSchema = {
			safeParse(d: unknown) {
				return typeof d === 'string'
					? { success: true as const, data: d }
					: { success: false as const, error: 'want string' }
			},
		}
		const res = await tick('r-1', {
			sql: db.sql,
			workflowFn: async () => 42,
			outputSchema: stringSchema,
		})
		expect(res.status).toBe('error')
		expect(res.error).toBe('output_mismatch')
		expect(db.run.status).toBe('error')
	})

	it('version_stale emits but the run continues (7.3)', async () => {
		expect.assertions(3)
		const events: { type: string }[] = []
		const db = fakeDb({
			run: { id: 'r-1', next_index: 0, deployment_url: 'https://old.vercel.app' },
		})
		const res = await tick('r-1', {
			sql: db.sql,
			workflowFn: async () => 'hello',
			prodDeploymentUrl: 'https://new.vercel.app',
			onEvent: (e) => events.push(e),
		})
		expect(res.status).toBe('done')
		expect(events.filter((e) => e.type === 'version_stale')).toHaveLength(1)
		// Same deployment: no staleness signal.
		const quiet: { type: string }[] = []
		const db2 = fakeDb({
			run: { id: 'r-2', next_index: 0, deployment_url: 'https://same.vercel.app' },
		})
		await tick('r-2', {
			sql: db2.sql,
			workflowFn: async () => 'hello',
			prodDeploymentUrl: 'https://same.vercel.app',
			onEvent: (e) => quiet.push(e),
		})
		expect(quiet.filter((e) => e.type === 'version_stale')).toHaveLength(0)
	})

	it('first open suspends to waiting (replay hits it next tick)', async () => {
		expect.assertions(3)
		const db = fakeDb({ run: { id: 'r-1', next_index: 0 } })
		const first = await tick('r-1', {
			sql: db.sql,
			workflowFn: async (wf) => wf.use.tool({ q: 1 }),
		})
		expect(first.status).toBe('waiting')
		expect(first.opened).toHaveLength(1)
		// Resolve the row, replay: journal hit returns the stored output.
		db.rows.get(0)!.status = 'resolved'
		db.rows.get(0)!.output_json = { ok: true }
		db.run.next_index = 1
		const second = await tick('r-1', {
			sql: db.sql,
			workflowFn: async (wf: WFContext<ToolRegistry>) => {
				const v = await (wf.use.tool as (i: unknown) => Promise<unknown>)({ q: 1 })
				return v
			},
		})
		expect(second.status).toBe('done')
	})

	it('swallowed sentinel on the success path is swallowed_sentinel, never done (R0)', async () => {
		expect.assertions(2)
		const db = fakeDb({ run: { id: 'r-1', next_index: 0 } })
		const res = await tick('r-1', {
			sql: db.sql,
			workflowFn: async (wf) => {
				try {
					await wf.use.tool({ q: 1 })
				} catch {
					// user swallows the Suspend sentinel — R0 must catch it.
				}
				return 'oops'
			},
		})
		expect(res.status).toBe('error')
		expect(res.error).toBe('swallowed_sentinel')
	})

	it('uncaught InteractionFailed fails the run; catch-all is workflow_throw', async () => {
		expect.assertions(4)
		const failed = row(0, { kind: 'tool', status: 'failed', error: 'boom' })
		const db1 = fakeDb({ run: { id: 'r-1', next_index: 1 }, rows: [failed] })
		const r1 = await tick('r-1', {
			sql: db1.sql,
			workflowFn: async (wf) => wf.use.tool({ q: 1 }),
		})
		expect(r1.status).toBe('error')
		expect(r1.error).toBe('boom')
		const db2 = fakeDb({ run: { id: 'r-1', next_index: 0 } })
		const r2 = await tick('r-1', {
			sql: db2.sql,
			workflowFn: async () => {
				throw new TypeError('nope')
			},
		})
		expect(r2.status).toBe('error')
		expect(r2.error).toBe('workflow_throw')
	})

	it('journal miss and payload mismatch are NonDeterminism step errors', async () => {
		expect.assertions(4)
		// Miss: counter advanced past the journal (fewer opens than before).
		const db1 = fakeDb({ run: { id: 'r-1', next_index: 2 }, rows: [] })
		const r1 = await tick('r-1', {
			sql: db1.sql,
			workflowFn: async (wf) => wf.use.tool({ q: 1 }),
		})
		expect(r1.status).toBe('error')
		expect(r1.error).toBe('NonDeterminism')
		// Mismatch: same idx, different input.
		const stored = row(0, { kind: 'tool', input_json: { q: 1 }, output_json: 1 })
		const db2 = fakeDb({ run: { id: 'r-1', next_index: 1 }, rows: [stored] })
		const r2 = await tick('r-1', {
			sql: db2.sql,
			workflowFn: async (wf: WFContext<ToolRegistry>) =>
				(wf.use.tool as (i: unknown) => Promise<unknown>)({ q: 2 }),
		})
		expect(r2.status).toBe('error')
		expect(r2.error).toBe('NonDeterminism')
	})
})

describe('sentinel collection §3.6 (2.2/2.3)', () => {
	it('StepError beats Suspend in collectOutcome', () => {
		expect.assertions(2)
		expect(
			collectOutcome(
				new Map([
					[0, { kind: 'suspend', idx: 0 }],
					[1, { kind: 'step-error', code: 'session_double_prompt', idx: 1 }],
				])
			)
		).toEqual({ stepError: { code: 'session_double_prompt', idx: 1 } })
		expect(hasControlFlowOutcome(new Map([[0, { kind: 'value', value: 1 }]]))).toBe(false)
	})

	it('double prompt on one session in a batch reports StepError, never hangs (A2)', async () => {
		expect.assertions(4)
		const db = fakeDb({ run: { id: 'r-1', next_index: 0 } })
		const sessionFn = async (wf: WFContext<ToolRegistry>) => {
			const s = await wf.createSession({
				model: 'm',
				systemPrompt: 'p',
				initialPrompt: 'hi',
			})
			// Two live prompts on the same receiver: idx k suspends,
			// idx k+1 raises the semaphore StepError — StepError wins.
			await wf.all([s.prompt('a', 'first'), s.prompt('b', 'second')])
			return 'never'
		}
		// Tick 1 opens the session row (createSession suspends after POST).
		const first = await tick('r-1', {
			sql: db.sql,
			postSession: async () => 'sess-1',
			workflowFn: sessionFn,
		})
		expect(first.status).toBe('waiting')
		// Tick 2 replays the session, then hits the semaphore StepError.
		const res = await tick('r-1', {
			sql: db.sql,
			postSession: async () => 'sess-1',
			workflowFn: sessionFn,
		})
		expect(res.status).toBe('error')
		expect(res.error).toBe('session_double_prompt')
		expect(db.run.status).toBe('error')
	})

	it('wf.all is fail-fast on InteractionFailed', async () => {
		expect.assertions(4)
		const bad = row(0, { kind: 'tool', status: 'failed', error: 'tool boom' })
		const db = fakeDb({ run: { id: 'r-1', next_index: 1 }, rows: [bad] })
		const res = await tick('r-1', {
			sql: db.sql,
			workflowFn: async (wf: WFContext<ToolRegistry>) => {
				const h = (wf.use.tool as (i: unknown) => Promise<unknown>)({ q: 1 })
				await expect(wf.all([h])).rejects.toBeInstanceOf(InteractionFailed)
				expect(true).toBe(true)
				throw new Error('fail-fast observed')
			},
		})
		expect(res.status).toBe('error')
		expect(res.error).toBe('workflow_throw')
	})
})

describe('sessions (3.1 R1)', () => {
	it('POST failure marks failed + StepError, terminal never waiting', async () => {
		expect.assertions(3)
		const db = fakeDb({ run: { id: 'r-1', next_index: 0 } })
		const res = await tick('r-1', {
			sql: db.sql,
			postSession: async () => {
				throw new Error('alfred down')
			},
			workflowFn: async (wf) =>
				wf.createSession({ model: 'm', systemPrompt: 'p', initialPrompt: 'hi' }),
		})
		expect(res.status).toBe('error')
		expect(res.error).toBe('session_create_failed')
		expect(db.queries.some((q) => q.includes("status = 'failed'"))).toBe(true)
	})

	it('replay returns the stored session id without POST', async () => {
		expect.assertions(3)
		let posts = 0
		const storedInput = {
			model: 'm',
			systemPrompt: 'p',
			initialPrompt: 'hi',
		}
		const stored = row(0, {
			kind: 'session',
			label: 'session',
			tool: null,
			status: 'open',
			session_id: 'sess-9',
			input_json: storedInput,
		})
		const db = fakeDb({ run: { id: 'r-1', next_index: 1 }, rows: [stored] })
		const res = await tick('r-1', {
			sql: db.sql,
			postSession: async () => {
				posts++
				return 'sess-new'
			},
			workflowFn: async (wf) => {
				const s = await wf.createSession(storedInput)
				return s.id
			},
		})
		expect(res.status).toBe('done')
		expect(res.returnValue).toBe('sess-9')
		expect(posts).toBe(0)
	})

	it('changed session input is NonDeterminism, never silent reuse', async () => {
		expect.assertions(2)
		const stored = row(0, {
			kind: 'session',
			label: 'session',
			tool: null,
			status: 'open',
			session_id: 'sess-9',
			input_json: { model: 'm', systemPrompt: 'p', initialPrompt: 'hi' },
		})
		const db = fakeDb({ run: { id: 'r-1', next_index: 1 }, rows: [stored] })
		const res = await tick('r-1', {
			sql: db.sql,
			postSession: async () => 'sess-new',
			workflowFn: async (wf) =>
				wf.createSession({ model: 'other', systemPrompt: 'p', initialPrompt: 'hi' }),
		})
		expect(res.status).toBe('error')
		expect(res.error).toBe('NonDeterminism')
	})
})

describe('once/now (4.6)', () => {
	it('Date.now() inside once replays identically; fn runs once', async () => {
		expect.assertions(5)
		let calls = 0
		const onceFn = async (wf: WFContext<ToolRegistry>) => wf.once('t', () => ++calls)
		const db = fakeDb({ run: { id: 'r-1', next_index: 0 } })
		const first = await tick('r-1', { sql: db.sql, workflowFn: onceFn })
		expect(first.status).toBe('done')
		expect(first.returnValue).toBe(1)
		expect(calls).toBe(1)
		// Second tick: run already `done` → returns the stored return value.
		const second = await tick('r-1', { sql: db.sql, workflowFn: onceFn })
		expect(second.status).toBe('done')
		expect(second.returnValue).toBe(1)
	})

	it('hash mismatch is a step error, never silent recompute', async () => {
		expect.assertions(3)
		const db = fakeDb({ run: { id: 'r-1', next_index: 0 } })
		const first = await tick('r-1', {
			sql: db.sql,
			workflowFn: async (wf: WFContext<ToolRegistry>) => wf.once('k', () => 1),
		})
		expect(first.status).toBe('done')
		// Fresh run row (same memo DB): replay with a different fn source.
		db.run.status = 'running'
		db.run.return_json = null
		const res = await tick('r-1', {
			sql: db.sql,
			workflowFn: async (wf: WFContext<ToolRegistry>) => wf.once('k', () => 2),
		})
		expect(res.status).toBe('error')
		expect(res.error).toBe('once_hash_mismatch')
	})

	it('once never consumes an interaction idx', async () => {
		expect.assertions(3)
		const db = fakeDb({ run: { id: 'r-1', next_index: 0 } })
		const fn = async (wf: WFContext<ToolRegistry>) => {
			const t = wf.once('stamp', () => 7)
			const v = await (wf.use.tool as (i: unknown) => Promise<unknown>)({ q: t })
			return v
		}
		const first = await tick('r-1', { sql: db.sql, workflowFn: fn })
		expect(first.status).toBe('waiting')
		expect(first.opened).toHaveLength(1)
		expect(first.opened[0].idx).toBe(0)
	})

	it('wf.now() warms through the memo loop (no too-many-misses spin)', async () => {
		expect.assertions(3)
		const uninstall = installSentinelRejectionGuard()
		try {
			const db = fakeDb({ run: { id: 'r-1', next_index: 0 } })
			const fn = async (wf: WFContext<ToolRegistry>) => {
				const t = wf.now()
				const v = await (wf.use.tool as (i: unknown) => Promise<unknown>)({ q: 1 })
				return { t, v }
			}
			const first = await tick('r-1', { sql: db.sql, workflowFn: fn })
			expect(first.status).toBe('waiting')
			expect(db.memos.has('now')).toBe(true)
			// Resolve the tool row: replay hits the warmed `now` memo.
			db.rows.get(0)!.status = 'resolved'
			db.rows.get(0)!.output_json = 'ok'
			const second = await tick('r-1', { sql: db.sql, workflowFn: fn })
			expect(second.status).toBe('done')
		} finally {
			uninstall()
		}
	})

	it('swapped expectedSchema is NonDeterminism, never silent reuse', async () => {
		expect.assertions(3)
		const uninstall = installSentinelRejectionGuard()
		try {
			const schemaA = {
				safeParse(d: unknown) {
					return typeof d === 'object' && d !== null
						? { success: true as const, data: d as { n: number } }
						: { success: false as const, error: 'want object' }
				},
			}
			const schemaB = {
				safeParse(d: unknown) {
					return typeof d === 'string'
						? { success: true as const, data: d as unknown as { n: number } }
						: { success: false as const, error: 'want string' }
				},
			}
			const db = fakeDb({ run: { id: 'r-1', next_index: 0 } })
			const fnA = async (wf: WFContext<ToolRegistry>) => {
				const s = await wf.createSession({
					model: 'm',
					systemPrompt: 'p',
					initialPrompt: 'hi',
				})
				return s.prompt('terms', 'give me JSON', { expectedSchema: schemaA })
			}
			await tick('r-1', { sql: db.sql, postSession: async () => 'sess-1', workflowFn: fnA })
			await tick('r-1', { sql: db.sql, postSession: async () => 'sess-1', workflowFn: fnA })
			// Same presence, different shape → identity mismatch on replay.
			const fnB = async (wf: WFContext<ToolRegistry>) => {
				const s = await wf.createSession({
					model: 'm',
					systemPrompt: 'p',
					initialPrompt: 'hi',
				})
				return s.prompt('terms', 'give me JSON', { expectedSchema: schemaB })
			}
			const res = await tick('r-1', {
				sql: db.sql,
				postSession: async () => 'sess-1',
				workflowFn: fnB,
			})
			expect(res.status).toBe('error')
			expect(res.error).toBe('NonDeterminism')
			expect(db.run.status).toBe('error')
		} finally {
			uninstall()
		}
	})
})

describe('2.4 unhandledRejection guard', () => {
	it('install/uninstall round-trips without crashing on a sentinel', async () => {
		expect.assertions(1)
		const uninstall = installSentinelRejectionGuard()
		process.emit('unhandledRejection', { kind: 'suspend', code: 'suspended' }, Promise.resolve())
		await new Promise((r) => setTimeout(r, 10))
		uninstall()
		expect(true).toBe(true)
	})
})

describe('review blockers §1–§5 + R3', () => {
	it('memo-after-fanout: once after fan-out opens replays without NonDeterminism (§1)', async () => {
		expect.assertions(5)
		// The memo-warm probe aborts mid-fan-out, leaving floating tool
		// handles that reject with Suspend sentinels and NO handler —
		// install the R2 guard so Node doesn't report them.
		const uninstall = installSentinelRejectionGuard()
		try {
			const db = fakeDb({ run: { id: 'r-1', next_index: 0 } })
			const fn = async (wf: WFContext<ToolRegistry>) => {
				const h = [1, 2].map((q) => (wf.use.tool as (i: unknown) => Promise<unknown>)({ q }))
				const t = wf.once('k', () => 42)
				const vs = await wf.all(h)
				return { vs, t }
			}
			const first = await tick('r-1', { sql: db.sql, workflowFn: fn })
			expect(first.status).toBe('waiting')
			// Both fan-out rows committed despite the aborted memo-warm attempt.
			expect(db.rows.size).toBe(2)
			db.rows.get(0)!.status = 'resolved'
			db.rows.get(0)!.output_json = 'a'
			db.rows.get(1)!.status = 'resolved'
			db.rows.get(1)!.output_json = 'b'
			const second = await tick('r-1', { sql: db.sql, workflowFn: fn })
			expect(second.status).toBe('done')
			expect((second.returnValue as { vs: unknown }).vs).toEqual(['a', 'b'])
			expect((second.returnValue as { t: unknown }).t).toBe(42)
		} finally {
			uninstall()
		}
	})

	it('all([failed, open]) surfaces the failure, never waits forever (§2)', async () => {
		expect.assertions(2)
		const bad = row(0, { kind: 'tool', input_json: { q: 1 }, status: 'failed', error: 'tool boom' })
		const open = row(1, { kind: 'tool', input_json: { q: 2 }, status: 'open' })
		const db = fakeDb({ run: { id: 'r-1', next_index: 2 }, rows: [bad, open] })
		const res = await tick('r-1', {
			sql: db.sql,
			workflowFn: async (wf: WFContext<ToolRegistry>) => {
				const tool = wf.use.tool as (i: unknown) => Promise<unknown>
				await wf.all([tool({ q: 1 }), tool({ q: 2 })])
				return 'never'
			},
		})
		expect(res.status).toBe('error')
		expect(res.error).toBe('tool boom')
	})

	it('concurrent createSession calls get distinct idxs (§3)', async () => {
		expect.assertions(5)
		const db = fakeDb({ run: { id: 'r-1', next_index: 0 } })
		let n = 0
		const postSession = async () => `sess-${++n}`
		const fn = async (wf: WFContext<ToolRegistry>) => {
			const input = { model: 'm', systemPrompt: 'p', initialPrompt: 'hi' }
			const [a, b] = await wf.all([wf.createSession(input), wf.createSession(input)])
			return [a.id, b.id]
		}
		const first = await tick('r-1', { sql: db.sql, postSession, workflowFn: fn })
		expect(first.status).toBe('waiting')
		expect(first.opened).toHaveLength(2)
		const second = await tick('r-1', { sql: db.sql, postSession, workflowFn: fn })
		expect(second.status).toBe('done')
		expect(second.returnValue).toEqual(['sess-1', 'sess-2'])
		// Replay performed no new POSTs.
		expect(n).toBe(2)
	})

	it('wf.log lines flush to the logbook (§4)', async () => {
		expect.assertions(2)
		const db = fakeDb({ run: { id: 'r-1', next_index: 0 } })
		const res = await tick('r-1', {
			sql: db.sql,
			workflowFn: async (wf) => {
				wf.log('hello', { n: 1 })
				return 'x'
			},
		})
		expect(res.status).toBe('done')
		expect(db.queries.some((q) => q.includes('INSERT INTO workflow_logbook'))).toBe(true)
	})

	it('cancelled round-trips distinct from error without re-executing (§5)', async () => {
		expect.assertions(3)
		let called = false
		const db = fakeDb({ run: { id: 'r-1', status: 'cancelled', error: 'user stop' } })
		const res = await tick('r-1', {
			sql: db.sql,
			workflowFn: async () => {
				called = true
				return 'never'
			},
		})
		expect(res.status).toBe('cancelled')
		expect(res.error).toBe('user stop')
		expect(called).toBe(false)
	})

	it('throwing describeStep leaves no open row (R3)', async () => {
		expect.assertions(3)
		const db = fakeDb({ run: { id: 'r-1', next_index: 0 } })
		const res = await tick('r-1', {
			sql: db.sql,
			describeStep: () => {
				throw new Error('ui down')
			},
			workflowFn: async (wf) => wf.use.tool({ q: 1 }),
		})
		expect(res.status).toBe('error')
		expect(res.error).toBe('describeStep_throw')
		expect(db.rows.size).toBe(0)
	})
})

describe('budgets + tick timeout (2.5/6.1)', () => {
	it('pure infinite loop aborts with tick_timeout, never hangs', async () => {
		expect.assertions(2)
		const db = fakeDb({ run: { id: 'r-1', next_index: 0 } })
		const res = await tick('r-1', {
			sql: db.sql,
			tickMaxMs: 20,
			workflowFn: async () => {
				while (true) {
					await new Promise((r) => setTimeout(r, 5))
				}
			},
		})
		expect(res.status).toBe('error')
		expect(res.error).toBe('tick_timeout')
	})

	it('maxOpens blocks the (maxOpens+1)-th open', async () => {
		expect.assertions(3)
		const db = fakeDb({ run: { id: 'r-1', next_index: 0 } })
		const res = await tick('r-1', {
			sql: db.sql,
			maxOpens: 1,
			workflowFn: async (wf: WFContext<ToolRegistry>) => {
				const tool = wf.use.tool as (i: unknown) => Promise<unknown>
				const h = [tool({ q: 1 }), tool({ q: 2 })]
				await wf.all(h)
				return 'never'
			},
		})
		expect(res.status).toBe('error')
		expect(res.error).toBe('budget_exceeded:maxOpens')
		// Only the first open committed; the second never reached the TX.
		expect(db.rows.size).toBe(1)
	})

	it('maxBytes counts input_json; oversized input fails the tick', async () => {
		expect.assertions(2)
		const db = fakeDb({ run: { id: 'r-1', next_index: 0 } })
		const res = await tick('r-1', {
			sql: db.sql,
			maxBytes: 10,
			workflowFn: async (wf: WFContext<ToolRegistry>) =>
				(wf.use.tool as (i: unknown) => Promise<unknown>)({ q: 'way-too-long-payload' }),
		})
		expect(res.status).toBe('error')
		expect(res.error).toBe('budget_exceeded:maxBytes')
	})

	it('maxWallMs fails stale runs at tick start without executing', async () => {
		expect.assertions(3)
		let called = false
		const db = fakeDb({
			run: { id: 'r-1', next_index: 0, created_at: new Date(0).toISOString() },
		})
		const res = await tick('r-1', {
			sql: db.sql,
			maxWallMs: 1000,
			now: () => 60_000,
			workflowFn: async () => {
				called = true
				return 'never'
			},
		})
		expect(res.status).toBe('error')
		expect(res.error).toBe('budget_exceeded:maxWallMs')
		expect(called).toBe(false)
	})
})

describe('structured output + scheduling + stream + cancel (4.2/4.3/4.4/5.2/5.3/6.2)', () => {
	const numSchema = {
		safeParse(d: unknown) {
			return typeof d === 'object' && d !== null && typeof (d as { n?: unknown }).n === 'number'
				? { success: true as const, data: d as { n: number } }
				: { success: false as const, error: 'want { n: number }' }
		},
	}

	it('4.4: structured prompt validates on resolve; journal holds typed data', async () => {
		expect.assertions(5)
		const uninstall = installSentinelRejectionGuard()
		try {
			const db = fakeDb({ run: { id: 'r-1', next_index: 0 } })
			const fn = async (wf: WFContext<ToolRegistry>) => {
				const s = await wf.createSession({
					model: 'm',
					systemPrompt: 'p',
					initialPrompt: 'hi',
				})
				return s.prompt('terms', 'give me JSON', { expectedSchema: numSchema })
			}
			const first = await tick('r-1', {
				sql: db.sql,
				postSession: async () => 'sess-1',
				workflowFn: fn,
			})
			expect(first.status).toBe('waiting')
			// Tick 1 opens the session row only (createSession suspends
			// after POST) — the prompt opens on tick 2.
			expect(db.rows.size).toBe(1)
			const second = await tick('r-1', {
				sql: db.sql,
				postSession: async () => 'sess-1',
				workflowFn: fn,
			})
			expect(second.status).toBe('waiting')
			// Session row is idx 0, prompt row is idx 1. Resolve the
			// prompt with a fenced answer: the ladder extracts +
			// validates, replay returns the typed value.
			db.rows.get(1)!.status = 'resolved'
			db.rows.get(1)!.output_json = '```json\n{"n": 3}\n```'
			const third = await tick('r-1', {
				sql: db.sql,
				postSession: async () => 'sess-1',
				workflowFn: fn,
			})
			expect(third.status).toBe('done')
			expect(third.returnValue).toEqual({ n: 3 })
		} finally {
			uninstall()
		}
	})

	it('4.4: schema mismatch resolves failed → InteractionFailed is catchable', async () => {
		expect.assertions(3)
		const uninstall = installSentinelRejectionGuard()
		try {
			const db = fakeDb({ run: { id: 'r-1', next_index: 0 } })
			const fn = async (wf: WFContext<ToolRegistry>) => {
				const s = await wf.createSession({
					model: 'm',
					systemPrompt: 'p',
					initialPrompt: 'hi',
				})
				try {
					await s.prompt('terms', 'give me JSON', { expectedSchema: numSchema })
					return 'no-fallback'
				} catch (e) {
					if (e instanceof InteractionFailed) return 'fallback'
					throw e
				}
			}
			// Tick 1 opens the session, tick 2 opens the prompt.
			await tick('r-1', { sql: db.sql, postSession: async () => 'sess-1', workflowFn: fn })
			await tick('r-1', { sql: db.sql, postSession: async () => 'sess-1', workflowFn: fn })
			db.rows.get(1)!.status = 'resolved'
			db.rows.get(1)!.output_json = '{"n": "not-a-number"}'
			const second = await tick('r-1', {
				sql: db.sql,
				postSession: async () => 'sess-1',
				workflowFn: fn,
			})
			expect(second.status).toBe('done')
			expect(second.returnValue).toBe('fallback')
			expect(db.run.status).toBe('done')
		} finally {
			uninstall()
		}
	})

	it('4.2: wired runTool is enqueued on open (not inline); row suspends', async () => {
		expect.assertions(4)
		const enqueued: { tool: string; input: unknown }[] = []
		const db = fakeDb({ run: { id: 'r-1', next_index: 0 } })
		const res = await tick('r-1', {
			sql: db.sql,
			runTool: async (tool, input) => {
				enqueued.push({ tool, input })
			},
			workflowFn: async (wf) => wf.use.tool({ q: 1 }),
		})
		expect(res.status).toBe('waiting')
		expect(enqueued).toEqual([{ tool: 'tool', input: { q: 1 } }])
		expect(db.rows.size).toBe(1)
		expect(db.rows.get(0)!.status).toBe('open')
	})

	it('4.3: pre-fixed ask-human resolves at open with no stream event', async () => {
		expect.assertions(4)
		const events: unknown[] = []
		const db = fakeDb({ run: { id: 'r-1', next_index: 0 } })
		const res = await tick('r-1', {
			sql: db.sql,
			prefixedAnswers: { confirm: 'yes' },
			onEvent: (e) => {
				if (e.type !== 'interaction_opened') events.push(e)
			},
			workflowFn: async (wf: WFContext<ToolRegistry>) =>
				(wf.use['ask-human'] as (i: unknown, o?: { label?: string }) => Promise<unknown>)(
					{ question: 'go?' },
					{ label: 'confirm' }
				),
		})
		expect(res.status).toBe('done')
		expect(res.returnValue).toBe('yes')
		expect(db.rows.get(0)!.status).toBe('resolved')
		// The open committed (idx consumed) but published no
		// `interaction_opened` event (only `run_status: done`).
		expect(events).toEqual([{ type: 'run_status', status: 'done' }])
	})

	it('5.2: opens emit interaction_opened; tick end emits run_status', async () => {
		expect.assertions(6)
		const events: { type: string; idx?: number; kind?: string; status?: string }[] = []
		const db = fakeDb({ run: { id: 'r-1', next_index: 0 } })
		const res = await tick('r-1', {
			sql: db.sql,
			onEvent: (e) => events.push(e as { type: string; idx?: number; status?: string }),
			workflowFn: async (wf) => wf.use.tool({ q: 1 }),
		})
		expect(res.status).toBe('waiting')
		expect(events.filter((e) => e.type === 'interaction_opened')).toHaveLength(1)
		expect(events[events.length - 1]).toMatchObject({ type: 'run_status', status: 'waiting' })
		// Prompt + session opens emit too (R4 — FE renders from label_text alone).
		const uninstall = installSentinelRejectionGuard()
		try {
			const db2 = fakeDb({ run: { id: 'r-2', next_index: 0 } })
			const kinds: string[] = []
			const sessionFn = async (wf: WFContext<ToolRegistry>) => {
				const s = await wf.createSession({
					model: 'm',
					systemPrompt: 'p',
					initialPrompt: 'hi',
				})
				await s.prompt('q', 'hello?')
				return 'never'
			}
			const t1 = await tick('r-2', {
				sql: db2.sql,
				postSession: async () => 'sess-1',
				onEvent: (e) => {
					if (e.type === 'interaction_opened') kinds.push(e.kind)
				},
				workflowFn: sessionFn,
			})
			expect(t1.status).toBe('waiting')
			// Tick 1 opens the session row only (createSession suspends
			// after POST); tick 2 opens the prompt row.
			const t2 = await tick('r-2', {
				sql: db2.sql,
				postSession: async () => 'sess-1',
				onEvent: (e) => {
					if (e.type === 'interaction_opened') kinds.push(e.kind)
				},
				workflowFn: sessionFn,
			})
			expect(t2.status).toBe('waiting')
			expect(kinds).toEqual(['session', 'prompt'])
		} finally {
			uninstall()
		}
	})

	it('5.3: resolveInteraction guards open-only; double resolve is a no-op', async () => {
		expect.assertions(3)
		const { resolveInteraction } = await import('./journal.js')
		const open = row(0, { kind: 'tool', status: 'open' })
		const db = fakeDb({ run: { id: 'r-1', next_index: 1 }, rows: [open] })
		const first = await resolveInteraction(
			'r-1',
			0,
			{ status: 'resolved', output: { ok: true } },
			db.sql
		)
		expect(first?.status).toBe('resolved')
		const second = await resolveInteraction('r-1', 0, { status: 'failed', error: 'late' }, db.sql)
		expect(second).toBeNull()
		expect(db.rows.get(0)!.status).toBe('resolved')
	})

	it('6.2: cancelRun flips opens + run to cancelled, journal preserved', async () => {
		expect.assertions(6)
		const { cancelRun } = await import('./journal.js')
		const open = row(0, { kind: 'tool', status: 'open' })
		const db = fakeDb({ run: { id: 'r-1', next_index: 1 }, rows: [open] })
		expect(await cancelRun('r-1', db.sql)).toBe(1)
		expect(db.rows.get(0)!.status).toBe('cancelled')
		expect(db.run.status).toBe('cancelled')
		// Terminal cancelled short-circuits without re-executing.
		let called = false
		const res = await tick('r-1', {
			sql: db.sql,
			workflowFn: async () => {
				called = true
				return 'never'
			},
		})
		expect(res.status).toBe('cancelled')
		expect(called).toBe(false)
		// Terminal-guarded: cancelling a done run is a no-op (0, journal untouched).
		db.run.status = 'done'
		expect(await cancelRun('r-1', db.sql)).toBe(0)
	})
})
