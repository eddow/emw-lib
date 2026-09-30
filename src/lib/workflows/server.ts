/**
 * Server-only asyncWF engine (import via `emw-lib/workflows-server`, never
 * from browser code or the client-safe barrel — same split as
 * `emw-lib/db-server`, `emw-lib/alfred-server`, `emw-lib/auth-server`).
 *
 * The host app owns its `migrations/*.sql` files, its `DATABASE_URL` env
 * and its Neon client; the lib owns the journal SQL + tick driver so every
 * app gets the same replay/suspend core. The host passes its `sql` client
 * in (`TickDeps.sql`, required) — the lib never imports `$env/*`,
 * `$lib/server` or a host `db.ts` (same rule as `AuthEnv`/`AuthDb`).
 */

export type {
	CallOutcome,
	StepErrorCode,
	TickDeps,
	TickResult,
	TickState,
} from './driver.js'
export {
	collectOutcome,
	committedOpens,
	hasControlFlowOutcome,
	installSentinelRejectionGuard,
	journalBytes,
	tick,
} from './driver.js'
export type {
	CreateRunInput,
	InteractionKind,
	InteractionStatus,
	OpenInteractionInput,
	RunStatus,
	WorkflowInteractionRow,
	WorkflowMemoRow,
	WorkflowRunRow,
	WorkflowSql,
} from './journal.js'
export {
	appendLogbook,
	createRun,
	getRun,
	listInteractions,
	openInteraction,
	readMemo,
	resolveExpiries,
	writeMemo,
} from './journal.js'
