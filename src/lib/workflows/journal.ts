/**
 * asyncWF journal helpers — persistence over the host's workflow tables
 * (checklist Phase 1.2, specs §§3.2–3.4). Server-only: import via
 * `emw-lib/workflows-server`, never from browser code or the client-safe
 * barrel (same split as `emw-lib/db-server`, `emw-lib/alfred-server`).
 *
 * The host owns its `migrations/*.sql` files, its `DATABASE_URL` env and
 * its Neon client; the lib owns the journal SQL so every app gets the same
 * atomic open TX, expiry sweep, memo read/write and logbook append. The
 * lib never imports `$env/*`, `$lib/server` or a host `db.ts` — the host
 * passes its `sql` client in (same rule as `AuthEnv`/`AuthDb` in
 * `emw-lib/auth-server`).
 *
 * - Atomic open TX: INSERT the interaction row + bump `next_index` in one
 *   Neon `sql.transaction()` (specs §3.3, §A4). A crash between the two
 *   leaves no half-open state — the TX rolls back and the next tick
 *   re-opens the same `idx`.
 * - `resolveExpiries`: open + past `expires_at` → `expired` (specs §7).
 * - Memo read/write under the `memo:` namespace (specs §2.3).
 * - Logbook append: only persisted-lines counting (specs §3.4, §7).
 */

/**
 * Minimal Neon client surface the journal needs — satisfied by the Neon
 * HTTP client (`getSql()` in the host's `src/lib/server/db.ts`) and by
 * test fakes. Structural on purpose: the lib must not import the host's
 * `db.ts` (that would drag `$env/dynamic/private` into `emw-lib`).
 */
export type WorkflowSql = {
	(strings: TemplateStringsArray, ...vals: unknown[]): Promise<unknown[]>
	transaction: <T>(fn: (txn: WorkflowSql) => T[]) => Promise<T[]>
}

export type InteractionKind = 'prompt' | 'tool' | 'session'
export type InteractionStatus = 'open' | 'resolved' | 'failed' | 'cancelled' | 'expired'
export type RunStatus = 'running' | 'waiting' | 'done' | 'error' | 'cancelled'

export interface WorkflowRunRow {
	id: string
	workflow_name: string
	workflow_version: number
	input_json: unknown
	deployment_url: string
	prod_deployment_url: string
	status: RunStatus
	next_index: number
	return_json: unknown
	error: string | null
	opens_used: number
	bytes_used: number
	tick: number
	created_at: string
	updated_at: string
}

export interface WorkflowInteractionRow {
	id: number
	run_id: string
	idx: number
	kind: InteractionKind
	label: string
	label_text: string
	tool: string | null
	input_json: unknown
	status: InteractionStatus
	output_json: unknown
	error: string | null
	session_id: string | null
	toolset_json: unknown
	expires_at: string | null
	created_at: string
	updated_at: string
}

export interface WorkflowMemoRow {
	run_id: string
	key: string
	fn_hash: string
	output_json: unknown
	created_at: string
}

export interface OpenInteractionInput {
	kind: InteractionKind
	label: string
	label_text: string
	tool?: string | null
	inputJson?: unknown
	sessionId?: string | null
	toolsetJson?: unknown
	expiresAt?: string | null
}

export interface CreateRunInput {
	workflowName: string
	workflowVersion: number
	inputJson?: unknown
	/** §8 pinning: home deployment + production HEAD seen at start. */
	deploymentUrl: string
	prodDeploymentUrl?: string
}

/**
 * Atomic open: INSERT the interaction row at `idx` + bump the run's
 * `next_index` to `idx + 1` in one transaction. Returns the inserted row.
 *
 * Crash-between-INSERT-and-bump is impossible by construction — both
 * statements commit or roll back together, so a retry re-opens the same
 * `idx` instead of skipping it.
 *
 * Idempotent on `(run_id, idx)`: a memo-warm re-execution (§2.3) can
 * re-open idxs whose INSERT TXs from the aborted attempt already
 * committed (or are still in flight). The conflict returns the existing
 * row instead of violating `UNIQUE (run_id, idx)`.
 *
 * `bytes_used` accounting (specs §7, incl. memo bytes) is owned by the
 * Phase 2 tick driver, not here: only the driver knows the resolved
 * `output_json` sizes at resolve time. This helper bumps `opens_used`
 * only.
 */
export async function openInteraction(
	runId: string,
	idx: number,
	input: OpenInteractionInput,
	sql: WorkflowSql
): Promise<WorkflowInteractionRow[]> {
	const out = (await sql.transaction((txn) => [
		txn`
			INSERT INTO workflow_interactions
				(run_id, idx, kind, label, label_text, tool, input_json, status, session_id, toolset_json, expires_at)
			VALUES (
				${runId}, ${idx}, ${input.kind}, ${input.label}, ${input.label_text},
				${input.tool ?? null}, ${JSON.stringify(input.inputJson ?? {})}::jsonb, 'open',
				${input.sessionId ?? null}, ${input.toolsetJson ? JSON.stringify(input.toolsetJson) : null}::jsonb,
				${input.expiresAt ?? null}
			)
			ON CONFLICT (run_id, idx) DO NOTHING
			RETURNING id, run_id, idx, kind, label, label_text, tool,
				input_json AS "input_json", status,
				output_json AS "output_json", error, session_id,
				toolset_json AS "toolset_json", expires_at, created_at, updated_at`,
		txn`
			UPDATE workflow_runs
			SET next_index = ${idx + 1}, opens_used = opens_used + 1, updated_at = NOW()
			WHERE id = ${runId} AND next_index <= ${idx}`,
	])) as unknown as [WorkflowInteractionRow[], { id: string }[]]
	if (out[0].length) return out[0]
	// Conflict: the aborted attempt already opened this idx — return the winner.
	const existing = (await sql`
		SELECT id, run_id, idx, kind, label, label_text, tool,
			input_json AS "input_json", status,
			output_json AS "output_json", error, session_id,
			toolset_json AS "toolset_json", expires_at, created_at, updated_at
		FROM workflow_interactions
		WHERE run_id = ${runId} AND idx = ${idx}
	`) as WorkflowInteractionRow[]
	return existing
}

/**
 * Insert the run row (owned by the starter, Phase 2 tick driver).
 * `deploymentUrl` is required — §8 pinning is load-bearing, no URL-less runs.
 */
export async function createRun(input: CreateRunInput, sql: WorkflowSql): Promise<WorkflowRunRow> {
	if (!input.deploymentUrl) throw new Error('"deploymentUrl" is required')
	const rows = (await sql`
		INSERT INTO workflow_runs
			(workflow_name, workflow_version, input_json, deployment_url, prod_deployment_url)
		VALUES (
			${input.workflowName}, ${input.workflowVersion},
			${JSON.stringify(input.inputJson ?? {})}::jsonb,
			${input.deploymentUrl}, ${input.prodDeploymentUrl ?? ''}
		)
		RETURNING id, workflow_name, workflow_version, input_json AS "input_json",
			deployment_url, prod_deployment_url, status,
			next_index, return_json AS "return_json", error,
			opens_used, bytes_used, tick, created_at, updated_at
	`) as WorkflowRunRow[]
	return rows[0]
}

/** Load a run row by id (null when unknown). */
export async function getRun(runId: string, sql: WorkflowSql): Promise<WorkflowRunRow | null> {
	const rows = (await sql`
		SELECT id, workflow_name, workflow_version, input_json AS "input_json",
			deployment_url, prod_deployment_url, status,
			next_index, return_json AS "return_json", error,
			opens_used, bytes_used, tick, created_at, updated_at
		FROM workflow_runs WHERE id = ${runId}
	`) as WorkflowRunRow[]
	return rows[0] ?? null
}

/** Load the full interaction journal for a run, ordered by `idx`. */
export async function listInteractions(
	runId: string,
	sql: WorkflowSql
): Promise<WorkflowInteractionRow[]> {
	return (await sql`
		SELECT id, run_id, idx, kind, label, label_text, tool,
			input_json AS "input_json", status,
			output_json AS "output_json", error, session_id,
			toolset_json AS "toolset_json", expires_at, created_at, updated_at
		FROM workflow_interactions
		WHERE run_id = ${runId}
		ORDER BY idx ASC
	`) as WorkflowInteractionRow[]
}

/**
 * Lazily expire: `open` rows past `expires_at` → `expired` (specs §7).
 * Returns the number of rows flipped.
 */
export async function resolveExpiries(runId: string, sql: WorkflowSql): Promise<number> {
	const rows = (await sql`
		UPDATE workflow_interactions
		SET status = 'expired', updated_at = NOW()
		WHERE run_id = ${runId} AND status = 'open'
			AND expires_at IS NOT NULL AND expires_at <= NOW()
		RETURNING id
	`) as { id: number }[]
	return rows.length
}

/** Read a memo row (`wf.once` cache, specs §2.3). Null on miss. */
export async function readMemo(
	runId: string,
	key: string,
	sql: WorkflowSql
): Promise<WorkflowMemoRow | null> {
	const rows = (await sql`
		SELECT run_id, key, fn_hash, output_json AS "output_json", created_at
		FROM workflow_memos WHERE run_id = ${runId} AND key = ${key}
	`) as WorkflowMemoRow[]
	return rows[0] ?? null
}

/** Write a memo row (first-write-wins; conflict keeps the stored value). */
export async function writeMemo(
	runId: string,
	key: string,
	fnHash: string,
	output: unknown,
	sql: WorkflowSql
): Promise<WorkflowMemoRow> {
	const rows = (await sql`
		INSERT INTO workflow_memos (run_id, key, fn_hash, output_json)
		VALUES (${runId}, ${key}, ${fnHash}, ${JSON.stringify(output)}::jsonb)
		ON CONFLICT (run_id, key) DO NOTHING
		RETURNING run_id, key, fn_hash, output_json AS "output_json", created_at
	`) as WorkflowMemoRow[]
	if (rows[0]) return rows[0]
	const existing = await readMemo(runId, key, sql)
	if (!existing) throw new Error(`memo not found after write: ${key}`)
	return existing
}

/**
 * Append logbook lines for a tick. Only lines from ticks that persist NEW
 * state count toward budgets (specs §3.4) — the caller decides when to
 * call; replay-only ticks emit nothing.
 */
export async function appendLogbook(
	runId: string,
	tick: number,
	lines: { label?: string; idx?: number | null; message: string; data?: unknown }[],
	sql: WorkflowSql
): Promise<void> {
	if (!lines.length) return
	const seqs = lines.map((_, i) => i)
	await sql`
		INSERT INTO workflow_logbook (run_id, tick, seq, label, idx, message, data_json)
		SELECT ${runId}, ${tick}, seq, label, idx, message, data_json
		FROM UNNEST(
			${seqs}::int[],
			${lines.map((l) => l.label ?? '')}::text[],
			${lines.map((l) => l.idx ?? null)}::int[],
			${lines.map((l) => l.message)}::text[],
			${lines.map((l) => (l.data === undefined ? null : JSON.stringify(l.data)))}::jsonb[]
		) AS u(seq, label, idx, message, data_json)
		ON CONFLICT (run_id, tick, seq) DO NOTHING`
}
