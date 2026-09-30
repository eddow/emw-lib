/**
 * Typed entry for the DB migration engine (import via `emw-lib/db-server`).
 *
 * Runtime lives in `./engine.js` (plain JS — see its header for why:
 * `vite.config.ts` is loaded by raw Node, which refuses TS files under
 * `node_modules` on Vercel). This file holds the canonical TypeScript
 * types + a re-export of the runtime, so `svelte-check` and IDEs see
 * full types while Node/Vite/Vercel load plain JS.
 *
 * `package.json` wires it up: `types` → this file, `default` → `engine.js`.
 * Keep the export list in sync with `engine.js` (enforced by the
 * export-parity test in `server.test.ts`).
 */

import type { Plugin } from 'vite'
import {
	ensureMigrationsTable as ensureMigrationsTableImpl,
	getAppliedMigrations as getAppliedMigrationsImpl,
	loadDotenvFallback as loadDotenvFallbackImpl,
	loadMigrationFiles as loadMigrationFilesImpl,
	migrateFromDir as migrateFromDirImpl,
	migrationsPlugin as migrationsPluginImpl,
	runDbMigrate as runDbMigrateImpl,
	runMigrations as runMigrationsImpl,
	splitStatements as splitStatementsImpl,
} from './engine.js'

/** Minimal surface the runner needs — satisfied by the Neon HTTP client. */
export interface MigrationDb {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	query: (queryWithPlaceholders: string, params?: any[]) => Promise<any>
}

export interface MigrationFile {
	name: string
	text: string
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

export const splitStatements: (source: string) => string[] = splitStatementsImpl
export const loadMigrationFiles: (dir: string) => Promise<MigrationFile[]> =
	loadMigrationFilesImpl as (dir: string) => Promise<MigrationFile[]>
export const ensureMigrationsTable: (sql: MigrationDb) => Promise<void> =
	ensureMigrationsTableImpl as (sql: MigrationDb) => Promise<void>
export const getAppliedMigrations: (sql: MigrationDb) => Promise<Set<string>> =
	getAppliedMigrationsImpl as (sql: MigrationDb) => Promise<Set<string>>
export const runMigrations: (sql: MigrationDb, files: MigrationFile[]) => Promise<string[]> =
	runMigrationsImpl as (sql: MigrationDb, files: MigrationFile[]) => Promise<string[]>
export const migrateFromDir: (sql: MigrationDb, dir: string) => Promise<string[]> =
	migrateFromDirImpl as (sql: MigrationDb, dir: string) => Promise<string[]>
export const loadDotenvFallback: (cwd?: string) => void = loadDotenvFallbackImpl
export const migrationsPlugin: (deps?: MigrationsPluginDeps) => Plugin = migrationsPluginImpl as (
	deps?: MigrationsPluginDeps
) => Plugin
export const runDbMigrate: (opts?: DbMigrateOptions) => Promise<string[]> = runDbMigrateImpl as (
	opts?: DbMigrateOptions
) => Promise<string[]>
