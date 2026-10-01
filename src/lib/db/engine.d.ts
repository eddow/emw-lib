/**
 * Type declarations for the plain-JS migration engine (`./engine.js`).
 *
 * WHY THIS FILE EXISTS:
 *
 * `server.ts` (the `types` entry of `emw-lib/db-server`) imports the runtime
 * from `./engine.js`. Inside `emw-lib` itself that resolves fine (`allowJs`
 * + `checkJs` include the JS source). But consumers (`emw`, `arb2b`) install
 * `emw-lib` from GitHub into `node_modules`, where `engine.js` is NOT part
 * of their TS program — so `svelte-check`/`tsc` reports TS7016 ("implicitly
 * has an 'any' type") for the `./engine.js` import.
 *
 * This sibling `.d.ts` gives TS the declarations it needs without touching
 * the runtime (Node/Vite/Vercel still load the plain `engine.js` — see its
 * header for why it must stay plain JS). Types here are intentionally
 * structural (`any` for the DB client / plugin deps) to avoid a type-only
 * circular import with `./server.ts`, which owns the canonical public
 * types and casts these `any`-ish signatures up.
 */

export interface EngineMigrationFile {
	name: string
	text: string
}

export declare function splitStatements(source: string): string[]
export declare function loadMigrationFiles(dir: string): Promise<EngineMigrationFile[]>
export declare function ensureMigrationsTable(
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	sql: any
): Promise<void>
export declare function getAppliedMigrations(
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	sql: any
): Promise<Set<string>>
export declare function runMigrations(
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	sql: any,
	files: EngineMigrationFile[]
): Promise<string[]>
export declare function migrateFromDir(
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	sql: any,
	dir: string
): Promise<string[]>
export declare function loadDotenvFallback(cwd?: string): void
export declare function migrationsPlugin(
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	deps?: any
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
): any
export declare function runDbMigrate(
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	opts?: any
): Promise<string[]>
