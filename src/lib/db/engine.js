/**
 * Plain-JS migration engine (import via `emw-lib/db-server`, never from
 * browser code or the client-safe barrel).
 *
 * WHY PLAIN JS — READ BEFORE ADDING TYPES HERE:
 *
 * `vite.config.ts` and `scripts/db-migrate.mjs` are loaded by plain Node
 * (Vite does NOT transpile its own config's bare imports — they stay
 * external and resolve at runtime). On Vercel/CI `emw-lib` installs from
 * GitHub into a real directory under `node_modules`, and since Node 22.6+
 * native type-stripping REFUSES files under `node_modules`
 * (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`). So the `./db-server`
 * `default` export MUST be plain JS with zero TypeScript syntax — no
 * annotations, no `as`, no `interface`, no `import type`, no enums.
 * JSDoc comments are fine (they are just comments to Node).
 *
 * The canonical public TYPES live in `./server.ts`, which re-exports this
 * file's runtime. `package.json` wires it up:
 * `"./db-server": { "types": "./src/lib/db/server.ts",
 * "default": "./src/lib/db/engine.js" }`.
 * Hosts keep `import { migrationsPlugin } from 'emw-lib/db-server'`
 * unchanged — Vite, Vitest and plain Node all resolve the JS entry.
 *
 * RULES for this file:
 * - No TypeScript syntax, ever. If `node --check` on this file fails,
 *   Vercel will fail too.
 * - Keep named exports in sync with `./server.ts` (the export-parity test
 *   in `server.test.ts` enforces this).
 * - JSDoc on every exported function (repo runs `checkJs`).
 */

import { existsSync, readFileSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

/**
 * Minimal surface the runner needs — satisfied by the Neon HTTP client.
 * @typedef {object} MigrationDb
 * @property {(queryWithPlaceholders: string, params?: any[]) => Promise<any>} query
 */

/**
 * @typedef {object} MigrationFile
 * @property {string} name
 * @property {string} text
 */

/**
 * @typedef {object} MigrationsPluginDeps
 * @property {string} [name] Log prefix (`emw-migrations`, `arb2b-migrations`, …).
 * @property {string} [dir] Migrations dir. Default: `<cwd>/migrations`.
 * @property {string} [databaseUrl] `DATABASE_URL` override (else `process.env`).
 * @property {(url: string) => MigrationDb | Promise<MigrationDb>} [connect]
 * Client factory override (else the default dynamic `neon` import).
 */

/**
 * @typedef {object} DbMigrateOptions
 * @property {string} [root] App root (dotenv lookup + default `migrations/` dir).
 * @property {string} [dir] Migrations dir override. Default: `<root>/migrations`.
 * @property {string} [databaseUrl] `DATABASE_URL` override (else `process.env` + dotenv fallback).
 * @property {(url: string) => MigrationDb | Promise<MigrationDb>} [connect]
 * Client factory override (else the default dynamic `neon` import).
 */

/**
 * Split a `.sql` file into single statements. The Neon HTTP driver runs one
 * statement per request, so multi-statement files must be split client-side.
 * Handles `--` line comments, `/* … *\/` blocks, `'...'`/`"..."` literals
 * (with `''`/`""` escapes) and `$tag$ … $tag$` dollar-quoting (so the
 * semicolons inside `DO $$ … $$` blocks don't split).
 * @param {string} source
 * @returns {string[]}
 */
export function splitStatements(source) {
	const statements = []
	let current = ''
	let i = 0
	const n = source.length
	let inSingle = false
	let inDouble = false
	/** @type {string | null} */
	let dollarTag = null

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

/**
 * Read `*.sql` files from `dir`, sorted by filename (strictly increasing).
 * @param {string} dir
 * @returns {Promise<MigrationFile[]>}
 */
export async function loadMigrationFiles(dir) {
	const entries = await readdir(dir)
	const names = entries.filter((e) => e.endsWith('.sql')).sort()
	const out = []
	for (const name of names) {
		out.push({ name, text: await readFile(path.join(dir, name), 'utf8') })
	}
	return out
}

/**
 * Create the bookkeeping table (not itself a migration — chicken-and-egg).
 * @param {MigrationDb} sql
 */
export async function ensureMigrationsTable(sql) {
	await sql.query(
		`CREATE TABLE IF NOT EXISTS schema_migrations (
			filename TEXT PRIMARY KEY,
			applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
		)`
	)
}

/**
 * Filenames already applied, from `schema_migrations`.
 * @param {MigrationDb} sql
 * @returns {Promise<Set<string>>}
 */
export async function getAppliedMigrations(sql) {
	/** @type {{ filename: string }[]} */
	const rows = await sql.query(`SELECT filename FROM schema_migrations`)
	return new Set(rows.map((r) => r.filename))
}

/**
 * Apply every file not yet in `schema_migrations`, in filename order.
 * Statements run sequentially (never wrapped in one transaction:
 * `ALTER TYPE … ADD VALUE` can't run inside a transaction block).
 * @param {MigrationDb} sql
 * @param {MigrationFile[]} files
 * @returns {Promise<string[]>} the applied filenames (empty = up to date).
 */
export async function runMigrations(sql, files) {
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
 * @param {MigrationDb} sql
 * @param {string} dir
 * @returns {Promise<string[]>} the applied filenames (empty = up to date).
 */
export async function migrateFromDir(sql, dir) {
	return runMigrations(sql, await loadMigrationFiles(dir))
}

/**
 * Minimal `.env*` fallback so `vite build` finds `DATABASE_URL` locally
 * (it lives in `.env.local`, which isn't in `process.env` when Vite
 * evaluates config). Vercel build env already has it — this is a no-op
 * there. Never overrides a real environment variable.
 * @param {string} [cwd]
 */
export function loadDotenvFallback(cwd = process.cwd()) {
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

/**
 * @param {string} connectionString
 * @returns {Promise<MigrationDb>}
 */
async function createNeonClient(connectionString) {
	const { neon } = await import('@neondatabase/serverless')
	return neon(connectionString)
}

/**
 * Vite plugin: apply pending `migrations/*.sql` during `vite build`.
 *
 * Skips silently when `DATABASE_URL` is unset (local builds without a DB)
 * or under Vitest (unit tests must never touch the live DB). When
 * configured, failures throw so a broken migration blocks the deploy.
 * @param {MigrationsPluginDeps} [deps]
 * @returns {import('vite').Plugin}
 */
export function migrationsPlugin(deps = {}) {
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
			const sql = deps.connect
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

/**
 * Manual migration runner behind `pnpm run db:migrate` (same logic as the
 * `vite build` plugin — applies pending `migrations/*.sql` in filename
 * order, tracked in `schema_migrations`). Read-only when up to date
 * (no-op). Never runs under Vitest. Throws when `DATABASE_URL` is unset
 * (checked in env + `.env*` files); the host script catches and exits 1.
 * @param {DbMigrateOptions} [opts]
 * @returns {Promise<string[]>} the applied filenames (empty = up to date).
 */
export async function runDbMigrate(opts = {}) {
	const root = opts.root ?? process.cwd()
	if (!opts.databaseUrl && !process.env.DATABASE_URL) loadDotenvFallback(root)
	const databaseUrl = opts.databaseUrl ?? process.env.DATABASE_URL
	if (!databaseUrl) {
		throw new Error('db:migrate: DATABASE_URL is not set (checked env + .env* files).')
	}
	const sql = opts.connect ? await opts.connect(databaseUrl) : await createNeonClient(databaseUrl)
	return migrateFromDir(sql, opts.dir ?? path.join(root, 'migrations'))
}
