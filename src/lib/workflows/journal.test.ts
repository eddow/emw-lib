import { describe, expect, it, vi } from 'vitest'
import {
	appendLogbook,
	createRun,
	getRun,
	listInteractions,
	openInteraction,
	readMemo,
	resolveExpiries,
	writeMemo,
} from './journal'

vi.mock('$env/dynamic/private', () => ({
	get env() {
		return process.env
	},
}))

/** Fake `sql` tagged-template stub dispatching on the query text. */
function fakeSql(handlers: Record<string, unknown[] | unknown>) {
	const queries: string[] = []
	const sql = Object.assign(
		async (strings: TemplateStringsArray, ..._vals: unknown[]) => {
			const text = strings.join(' ').replace(/\s+/g, ' ').trim()
			queries.push(text)
			for (const [key, rows] of Object.entries(handlers)) {
				if (text.includes(key)) return rows
			}
			return []
		},
		{
			transaction: async (fn: (txn: unknown) => unknown[]) => {
				const txn = (async (strings: TemplateStringsArray, ..._vals: unknown[]) => {
					const text = strings.join(' ').replace(/\s+/g, ' ').trim()
					queries.push(`TXN: ${text}`)
					for (const [key, rows] of Object.entries(handlers)) {
						if (text.includes(key)) return rows
					}
					// Idempotent open fallback: ON CONFLICT DO NOTHING
					// returns [] — the caller falls back to SELECT.
					if (text.includes('FROM workflow_interactions')) {
						for (const [key, rows] of Object.entries(handlers)) {
							if (key === 'INSERT') return rows
						}
					}
					return []
				}) as unknown
				// Mirror Neon: await every statement so one failure rejects
				// the whole TX (rolling back the INSERT too).
				const out: unknown[] = []
				for (const stmt of fn(txn)) out.push(await stmt)
				return out
			},
		}
	)
	return { sql: sql as unknown as Parameters<typeof getRun>[1], queries }
}

describe('openInteraction', () => {
	it('inserts the row and bumps next_index in one transaction', async () => {
		expect.assertions(5)
		const row = { id: 1, run_id: 'r-1', idx: 0, status: 'open' }
		const { sql, queries } = fakeSql({
			INSERT: [row],
			UPDATE: [{ id: 'r-1' }],
		})
		const out = await openInteraction(
			'r-1',
			0,
			{ kind: 'tool', label: 'search', label_text: 'Searching…', tool: 'serp_search' },
			sql
		)
		expect(out).toEqual([row])
		expect(queries.filter((q) => q.startsWith('TXN:'))).toHaveLength(2)
		expect(queries.some((q) => q.includes('INSERT INTO workflow_interactions'))).toBe(true)
		expect(queries.some((q) => q.includes('ON CONFLICT (run_id, idx) DO NOTHING'))).toBe(true)
		expect(queries.some((q) => q.includes('next_index'))).toBe(true)
	})

	it('conflict returns the existing row (memo-warm re-execution)', async () => {
		expect.assertions(3)
		const winner = { id: 7, run_id: 'r-1', idx: 2, status: 'open' }
		const { sql, queries } = fakeSql({
			INSERT: [],
			UPDATE: [{ id: 'r-1' }],
			'WHERE run_id =': [winner],
		})
		const out = await openInteraction(
			'r-1',
			2,
			{ kind: 'tool', label: 'search', label_text: 'Searching…' },
			sql
		)
		expect(out).toEqual([winner])
		expect(queries.some((q) => q.includes('ON CONFLICT (run_id, idx) DO NOTHING'))).toBe(true)
		expect(queries.some((q) => q.includes('WHERE run_id ='))).toBe(true)
	})

	it('crash between INSERT and bump rolls back: retry re-opens the same idx', async () => {
		expect.assertions(3)
		const queries: string[] = []
		const txn = (async (strings: TemplateStringsArray, ..._vals: unknown[]) => {
			const text = strings.join(' ').replace(/\s+/g, ' ').trim()
			queries.push(text)
			// Crash on the bump (second statement): the TX rolls back the
			// INSERT too, so the retry re-opens idx 3 instead of skipping it.
			if (text.includes('UPDATE workflow_runs')) throw new Error('connection reset')
			return []
		}) as unknown
		const sql = Object.assign(async () => [], {
			transaction: async (fn: (txn: unknown) => unknown[]) => {
				// Mirror Neon: await every statement so one failure rejects
				// the whole TX (rolling back the INSERT too).
				const out: unknown[] = []
				for (const stmt of fn(txn)) out.push(await stmt)
				return out
			},
		}) as unknown as Parameters<typeof openInteraction>[3]
		await expect(
			openInteraction('r-1', 3, { kind: 'prompt', label: 'terms', label_text: 'Asking…' }, sql)
		).rejects.toThrow('connection reset')
		// The bump threw, so the TX rolled back the INSERT too — the next
		// tick re-opens idx 3 instead of skipping it.
		expect(queries.some((q) => q.includes('INSERT INTO workflow_interactions'))).toBe(true)
		expect(queries.some((q) => q.includes('UPDATE workflow_runs'))).toBe(true)
	})
})

describe('resolveExpiries', () => {
	it('flips open + past-expires rows to expired', async () => {
		expect.assertions(2)
		const { sql, queries } = fakeSql({ UPDATE: [{ id: 1 }, { id: 2 }] })
		expect(await resolveExpiries('r-1', sql)).toBe(2)
		expect(queries[0]).toContain("SET status = 'expired'")
	})

	it('no-op when nothing is overdue', async () => {
		expect.assertions(1)
		const { sql } = fakeSql({ UPDATE: [] })
		expect(await resolveExpiries('r-1', sql)).toBe(0)
	})
})

describe('memo read/write', () => {
	it('writeMemo returns the inserted row; readMemo hits it', async () => {
		expect.assertions(2)
		const row = { run_id: 'r-1', key: 'now', fn_hash: 'abc', output_json: 123 }
		const { sql } = fakeSql({ INSERT: [row], 'FROM workflow_memos': [row] })
		expect(await writeMemo('r-1', 'now', 'abc', 123, sql)).toEqual(row)
		expect(await readMemo('r-1', 'now', sql)).toEqual(row)
	})

	it('writeMemo falls back to the stored row on conflict (first-write-wins)', async () => {
		expect.assertions(1)
		const stored = { run_id: 'r-1', key: 'now', fn_hash: 'abc', output_json: 1 }
		const { sql } = fakeSql({ INSERT: [], 'FROM workflow_memos': [stored] })
		expect(await writeMemo('r-1', 'now', 'abc', 2, sql)).toEqual(stored)
	})
})

describe('logbook + reads', () => {
	it('appendLogbook is a no-op on empty lines', async () => {
		expect.assertions(2)
		const { sql, queries } = fakeSql({})
		await appendLogbook('r-1', 0, [], sql)
		expect(queries).toHaveLength(0)
		await appendLogbook(
			'r-1',
			1,
			[{ label: 'terms', idx: 0, message: 'opened', data: { n: 1 } }],
			sql
		)
		expect(queries[0]).toContain('INSERT INTO workflow_logbook')
	})

	it('getRun returns null when unknown; listInteractions orders by idx', async () => {
		expect.assertions(3)
		const empty = fakeSql({})
		expect(await getRun('missing', empty.sql)).toBeNull()
		const { sql, queries } = fakeSql({ SELECT: [] })
		expect(await listInteractions('r-1', sql)).toEqual([])
		expect(queries[0]).toContain('ORDER BY idx ASC')
	})
})

describe('createRun', () => {
	it('inserts the run row with pinning urls', async () => {
		expect.assertions(3)
		const row = { id: 'r-1', workflow_name: 'w', workflow_version: 1, status: 'running' }
		const { sql, queries } = fakeSql({ INSERT: [row] })
		const out = await createRun(
			{ workflowName: 'w', workflowVersion: 1, deploymentUrl: 'https://x.vercel.app' },
			sql
		)
		expect(out).toEqual(row)
		expect(queries[0]).toContain('INSERT INTO workflow_runs')
		expect(queries[0]).toContain('deployment_url')
	})

	it('rejects a URL-less run (§8 pinning is load-bearing)', async () => {
		expect.assertions(2)
		const { sql, queries } = fakeSql({})
		await expect(
			createRun({ workflowName: 'w', workflowVersion: 1, deploymentUrl: '' }, sql)
		).rejects.toThrow('"deploymentUrl" is required')
		expect(queries).toHaveLength(0)
	})
})
