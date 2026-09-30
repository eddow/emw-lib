/**
 * Server-only DB + migration wiring (import via `emw-lib/db-server`, never
 * from browser code or the client-safe barrel).
 *
 * The host app owns its `migrations/*.sql` files, its `DATABASE_URL` env and
 * its Neon client; the lib owns the engine so every app gets the same
 * forward-only runner, the same `vite build` plugin and the same manual CLI:
 *
 * - {@link splitStatements} / {@link migrateFromDir} — the runner (Neon HTTP
 *   runs one statement per request, so multi-statement files split
 *   client-side; applied filenames tracked in `schema_migrations`).
 * - {@link migrationsPlugin} — applies pending `migrations/*.sql` during
 *   `vite build` (fails the build on broken migrations, skips silently
 *   without `DATABASE_URL` or under Vitest).
 * - {@link runDbMigrate} — the manual runner behind `pnpm run db:migrate`
 *   (same logic as the plugin; hosts keep a thin script wrapper).
 *
 * Each app has its OWN database, so migration *files* stay per-app — only
 * the engine is shared. The lib never imports `$app/*`, `$env/*` or
 * `$lib/server`; the host injects `connect` (or lets the default dynamic
 * `neon` import run) and passes `DATABASE_URL` through env or `deps`.
 */

import { existsSync, readFileSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import type { Plugin } from 'vite'

/** Minimal surface the runner needs — satisfied by the Neon HTTP client. */
export interface MigrationDb {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	query: (queryWithPlaceholders: string, params?: any[]) => Promise<any>
}

export interface MigrationFile {
	name: string
	text: string
}

/**
 * Split a `.sql` file into single statements. The Neon HTTP driver runs one
 * statement per request, so multi-statement files must be split client-side.
 * Handles `--` line comments, `/* … *\/` blocks, `'...'`/`"..."` literals
 * (with `''`/`""` escapes) and `$tag$ … $tag$` dollar-quoting (so the
 * semicolons inside `DO $$ … $$` blocks don't split).
 */
export function splitStatements(source: string): string[] {
	const statements: string[] = []
	let current = ''
	let i = 0
	const n = source.length
	let inSingle = false
	let inDouble = false
	let dollarTag: string | null = null

	while (i < n) {
		// Inside $tag$ … $tag$: only the closing tag is special.
		if (dollarTag !== null) {
			if (source.startsWith(dollarTag, i)) {
				current += dollarTag
				i += dollarTag.length
				dollarTag = null
			} else {
				current += source[i]
				i++
			}
			continue
		}
		const ch = source[i]
		if (inSingle) {
			current += ch
			if (ch === "'") {
				if (source[i + 1] === "'") {
					current += "'"
					i += 2
					continue
				}
				inSingle = false
			}
			i++
			continue
		}
		if (inDouble) {
			current += ch
			if (ch === '"') {
				if (source[i + 1] === '"') {
					current += '"'
					i += 2
					continue
				}
				inDouble = false
			}
			i++
			continue
		}
		if (ch === "'") {
			inSingle = true
			current += ch
			i++
			continue
		}
		if (ch === '"') {
			inDouble = true
			current += ch
			i++
			continue
		}
		// `--` line comment → skip to end of line.
		if (ch === '-' && source[i + 1] === '-') {
			while (i < n && source[i] !== '\n') i++
			continue
		}
		// `/* … */` block comment → skip.
		if (ch === '/' && source[i + 1] === '*') {
			i += 2
			while (i < n && !(source[i] === '*' && source[i + 1] === '/')) i++
			i += 2
			continue
		}
		// Dollar-quote open (`$$` or `$tag$`)?
		if (ch === '$') {
			const m = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(source.slice(i))
			if (m) {
				dollarTag = m[0]
				current += dollarTag
				i += dollarTag.length
				continue
			}
			current += ch
			i++
			continue
		}
		if (ch === ';') {
			const stmt = current.trim()
			if (stmt) statements.push(stmt)
			current = ''
			i++
			continue
		}
		current += ch
		i++
	}
	const tail = current.trim()
	if (tail) statements.push(tail)
	return statements
}

/** Read `*.sql` files from `dir`, sorted by filename (strictly increasing). */
export async function loadMigrationFiles(dir: string): Promise<MigrationFile[]> {
	const entries = await readdir(dir)
	const names = entries.filter((e) => e.endsWith('.sql')).sort()
	const out: MigrationFile[] = []
	for (const name of names) {
		out.push({ name, text: await readFile(path.join(dir, name), 'utf8') })
	}
	return out
}

/** Create the bookkeeping table (not itself a migration — chicken-and-egg). */
export async function ensureMigrationsTable(sql: MigrationDb): Promise<void> {
	await sql.query(
		`CREATE TABLE IF NOT EXISTS schema_migrations (
			filename TEXT PRIMARY KEY,
			applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
		)`
	)
}

/** Filenames already applied, from `schema_migrations`. */
export async function getAppliedMigrations(sql: MigrationDb): Promise<Set<string>> {
	const rows = (await sql.query(`SELECT filename FROM schema_migrations`)) as {
		filename: string
	}[]
	return new Set(rows.map((r) => r.filename))
}

/**
 * Apply every file not yet in `schema_migrations`, in filename order.
 * Statements run sequentially (never wrapped in one transaction:
 * `ALTER TYPE … ADD VALUE` can't run inside a transaction block).
 * @returns the applied filenames (empty = up to date).
 */
export async function runMigrations(sql: MigrationDb, files: MigrationFile[]): Promise<string[]> {
	await ensureMigrationsTable(sql)
	const applied = await getAppliedMigrations(sql)
	const pending = files
		.filter((f) => !applied.has(f.name))
		.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
	for (const file of pending) {
		for (const stmt of splitStatements(file.text)) {
			await sql.query(stmt)
		}
		await sql.query(`INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING`, [
			file.name,
		])
	}
	return pending.map((f) => f.name)
}

/**
 * Load `migrations/` from disk and apply what's pending.
 * @returns the applied filenames (empty = up to date).
 */
export async function migrateFromDir(sql: MigrationDb, dir: string): Promise<string[]> {
	return runMigrations(sql, await loadMigrationFiles(dir))
}

/**
 * Minimal `.env*` fallback so `vite build` finds `DATABASE_URL` locally
 * (it lives in `.env.local`, which isn't in `process.env` when Vite
 * evaluates config). Vercel build env already has it — this is a no-op
 * there. Never overrides a real environment variable.
 */
export function loadDotenvFallback(cwd: string = process.cwd()): void {
	if (process.env.DATABASE_URL) return
	for (const file of ['.env.production.local', '.env.local', '.env.production', '.env']) {
		const full = path.join(cwd, file)
		if (!existsSync(full)) continue
		for (const line of readFileSync(full, 'utf8').split('\n')) {
			const trimmed = line.trim()
			if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue
			const eq = trimmed.indexOf('=')
			const key = trimmed.slice(0, eq).trim()
			let value = trimmed.slice(eq + 1).trim()
			if (
				(value.startsWith('"') && value.endsWith('"')) ||
				(value.startsWith("'") && value.endsWith("'"))
			) {
				value = value.slice(1, -1)
			}
			if (key && process.env[key] === undefined) process.env[key] = value
		}
		if (process.env.DATABASE_URL) return
	}
}

export interface MigrationsPluginDeps {
	/** Log prefix (`emw-migrations`, `arb2b-migrations`, …). Default: `db-migrations`. */
	name?: string
	/** Migrations dir. Default: `<cwd>/migrations`. */
	dir?: string
	/** `DATABASE_URL` override (else `process.env`). */
	databaseUrl?: string
	/** Client factory override (else the default dynamic `neon` import). */
	connect?: (url: string) => MigrationDb | Promise<MigrationDb>
}

/**
 * Vite plugin: apply pending `migrations/*.sql` during `vite build`.
 *
 * Skips silently when `DATABASE_URL` is unset (local builds without a DB)
 * or under Vitest (unit tests must never touch the live DB). When
 * configured, failures throw so a broken migration blocks the deploy.
 */
export function migrationsPlugin(deps: MigrationsPluginDeps = {}): Plugin {
	const name = deps.name ?? 'db-migrations'
	// `vite build` (SvelteKit) invokes `buildStart` once per bundle
	// (client + server). Migrations must run exactly once per process.
	let ran = false
	return {
		name,
		apply: 'build',
		enforce: 'pre',
		async buildStart() {
			if (ran) return
			ran = true
			if (process.env.VITEST || process.env.VITEST_WORKER_ID) return
			loadDotenvFallback()
			const databaseUrl = deps.databaseUrl ?? process.env.DATABASE_URL
			if (!databaseUrl) {
				this.warn(`${name}: DATABASE_URL unset — skipping migrations.`)
				return
			}
			const dir = deps.dir ?? path.resolve(process.cwd(), 'migrations')
			const sql: MigrationDb = deps.connect
				? await deps.connect(databaseUrl)
				: await createNeonClient(databaseUrl)
			const applied = await migrateFromDir(sql, dir)
			if (applied.length > 0) {
				console.log(`[${name}] applied: ${applied.join(', ')}`)
			} else {
				console.log(`[${name}] up to date.`)
			}
		},
	}
}

async function createNeonClient(connectionString: string): Promise<MigrationDb> {
	const { neon } = await import('@neondatabase/serverless')
	return neon(connectionString) as unknown as MigrationDb
}

export interface DbMigrateOptions {
	/** App root (dotenv lookup + default `migrations/` dir). Default: `process.cwd()`. */
	root?: string
	/** Migrations dir override. Default: `<root>/migrations`. */
	dir?: string
	/** `DATABASE_URL` override (else `process.env` + dotenv fallback). */
	databaseUrl?: string
	/** Client factory override (else the default dynamic `neon` import). */
	connect?: (url: string) => MigrationDb | Promise<MigrationDb>
}

/**
 * Manual migration runner behind `pnpm run db:migrate` (same logic as the
 * `vite build` plugin — applies pending `migrations/*.sql` in filename
 * order, tracked in `schema_migrations`). Read-only when up to date
 * (no-op). Never runs under Vitest. Throws when `DATABASE_URL` is unset
 * (checked in env + `.env*` files); the host script catches and exits 1.
 *
 * @returns the applied filenames (empty = up to date).
 */
export async function runDbMigrate(opts: DbMigrateOptions = {}): Promise<string[]> {
	const root = opts.root ?? process.cwd()
	if (!opts.databaseUrl && !process.env.DATABASE_URL) loadDotenvFallback(root)
	const databaseUrl = opts.databaseUrl ?? process.env.DATABASE_URL
	if (!databaseUrl) {
		throw new Error('db:migrate: DATABASE_URL is not set (checked env + .env* files).')
	}
	const sql: MigrationDb = opts.connect
		? await opts.connect(databaseUrl)
		: await createNeonClient(databaseUrl)
	return migrateFromDir(sql, opts.dir ?? path.join(root, 'migrations'))
}
