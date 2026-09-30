import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as engine from './engine.js'
import {
	ensureMigrationsTable,
	getAppliedMigrations,
	loadDotenvFallback,
	loadMigrationFiles,
	type MigrationDb,
	migrateFromDir,
	migrationsPlugin,
	runDbMigrate,
	runMigrations,
	splitStatements,
} from './server.js'

/** In-memory fake of the `MigrationDb` surface (records queries, tracks the table). */
function fakeDb(seedApplied: string[] = []): MigrationDb & { queries: string[] } {
	const applied = new Set(seedApplied)
	const queries: string[] = []
	return {
		queries,
		query: async (text: string, params?: unknown[]) => {
			queries.push(text)
			if (text.startsWith('SELECT filename FROM schema_migrations')) {
				return [...applied].map((filename) => ({ filename }))
			}
			if (text.startsWith('INSERT INTO schema_migrations')) {
				applied.add(params?.[0] as string)
				return []
			}
			return []
		},
	}
}

describe('splitStatements', () => {
	it('splits on semicolons, drops comments and empties', () => {
		expect.assertions(1)
		expect(
			splitStatements(`-- a comment
CREATE TABLE t (id INT);
CREATE INDEX IF NOT EXISTS i ON t (id); -- trailing
`)
		).toEqual(['CREATE TABLE t (id INT)', 'CREATE INDEX IF NOT EXISTS i ON t (id)'])
	})
	it('keeps semicolons inside DO $$ blocks and string literals', () => {
		expect.assertions(1)
		expect(
			splitStatements(`DO $$ BEGIN
  CREATE TYPE s AS ENUM ('a;b');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
ALTER TYPE s ADD VALUE 'c';`)
		).toEqual([
			`DO $$ BEGIN\n  CREATE TYPE s AS ENUM ('a;b');\nEXCEPTION WHEN duplicate_object THEN NULL;\nEND $$`,
			`ALTER TYPE s ADD VALUE 'c'`,
		])
	})
	it('skips block comments', () => {
		expect.assertions(1)
		expect(splitStatements(`/* multi\nline */ SELECT 1;`)).toEqual(['SELECT 1'])
	})
	it('handles the real 0001 file shape (extensions + DO block + tables)', () => {
		expect.assertions(2)
		const stmts = splitStatements(`CREATE EXTENSION IF NOT EXISTS citext;
DO $$ BEGIN
  CREATE TYPE contact_status AS ENUM ('a', 'b');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
CREATE TABLE IF NOT EXISTS t (id INT);`)
		expect(stmts).toHaveLength(3)
		expect(stmts[1]).toContain('CREATE TYPE')
	})
})

describe('runMigrations', () => {
	it('applies pending files in order and records them', async () => {
		expect.assertions(3)
		const db = fakeDb(['0001_a.sql'])
		const applied = await runMigrations(db, [
			{ name: '0001_a.sql', text: 'SELECT 1;' },
			{ name: '0002_b.sql', text: 'SELECT 1; SELECT 2;' },
			{ name: '0003_c.sql', text: '-- only a comment' },
		])
		expect(applied).toEqual(['0002_b.sql', '0003_c.sql'])
		// 0002 runs its 2 statements + bookkeeping insert; 0003 only the insert.
		expect(db.queries.filter((q) => q.startsWith('SELECT 1'))).toHaveLength(1)
		expect(await getAppliedMigrations(db)).toEqual(
			new Set(['0001_a.sql', '0002_b.sql', '0003_c.sql'])
		)
	})
	it('is a no-op when everything is applied', async () => {
		expect.assertions(2)
		const db = fakeDb(['0001_a.sql'])
		const applied = await runMigrations(db, [{ name: '0001_a.sql', text: 'SELECT 1;' }])
		expect(applied).toEqual([])
		expect(db.queries.filter((q) => q === 'SELECT 1')).toHaveLength(0)
	})
})

describe('loadMigrationFiles', () => {
	const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'migrations')
	beforeAll(() => {
		mkdirSync(dir, { recursive: true })
		writeFileSync(path.join(dir, '0002_b.sql'), 'SELECT 2;\n')
		writeFileSync(path.join(dir, '0001_a.sql'), 'SELECT 1;\n')
		writeFileSync(path.join(dir, 'notes.txt'), 'ignored\n')
	})
	afterAll(() => {
		rmSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures'), {
			recursive: true,
			force: true,
		})
	})
	it('loads *.sql in increasing order, ignoring other files', async () => {
		expect.assertions(3)
		const files = await loadMigrationFiles(dir)
		expect(files.map((f) => f.name)).toEqual(['0001_a.sql', '0002_b.sql'])
		expect(files[0]?.text).toBe('SELECT 1;\n')
		expect(files).toHaveLength(2)
	})
})

describe('engine/server export parity', () => {
	it('engine.js and server.ts export the same runtime names', async () => {
		expect.assertions(2)
		const server = await import('./server.js')
		const expected = [
			'ensureMigrationsTable',
			'getAppliedMigrations',
			'loadDotenvFallback',
			'loadMigrationFiles',
			'migrateFromDir',
			'migrationsPlugin',
			'runDbMigrate',
			'runMigrations',
			'splitStatements',
		].sort()
		expect(Object.keys(engine).sort()).toEqual(expected)
		expect(
			Object.keys(server)
				.filter((k) => k !== 'default')
				.sort()
		).toEqual(expected)
	})
	it('typed wrapper delegates to the engine (spot-check)', () => {
		expect.assertions(9)
		expect(splitStatements).toBe(engine.splitStatements)
		expect(loadMigrationFiles).toBe(engine.loadMigrationFiles)
		expect(ensureMigrationsTable).toBe(engine.ensureMigrationsTable)
		expect(getAppliedMigrations).toBe(engine.getAppliedMigrations)
		expect(runMigrations).toBe(engine.runMigrations)
		expect(migrateFromDir).toBe(engine.migrateFromDir)
		expect(loadDotenvFallback).toBe(engine.loadDotenvFallback)
		expect(migrationsPlugin).toBe(engine.migrationsPlugin)
		expect(runDbMigrate).toBe(engine.runDbMigrate)
	})
})
