/**
 * Stable hashing for `wf.once` + journal identity
 * (`plans/asyncWF/specs.md` §§2.3, 3.2; checklist Phase 4.6).
 *
 * Client-safe: no `node:` imports, no env reads.
 *
 * - `fnSourceHash(fn)`: validation hash of `fn.toString()` (whitespace
 *   normalized). Source is a *validation* hash only — identity is the
 *   explicit `key`, never `fn.toString()` (fragile under
 *   formatting/minification; blind to closures).
 * - `stableStringify` / `payloadHash`: canonical JSON (sorted keys,
 *   `undefined` dropped like `JSON.stringify`) for `assertSameCall`
 *   payload comparison (specs §3.3: kind + label + hash, not full bytes).
 */

function fnv1aHex(input: string): string {
	let hash = 0x811c9dc5
	for (let i = 0; i < input.length; i++) {
		hash ^= input.charCodeAt(i)
		hash = Math.imul(hash, 0x01000193)
	}
	return (hash >>> 0).toString(16).padStart(8, '0')
}

/** Validation hash of a memo function source (whitespace-normalized). */
export function fnSourceHash(fn: (...args: never[]) => unknown): string {
	const src = Function.prototype.toString.call(fn).replace(/\s+/g, ' ').trim()
	return fnv1aHex(src)
}

/** Canonical JSON: sorted object keys, `undefined`/functions dropped like `JSON.stringify`. */
export function stableStringify(value: unknown): string {
	return JSON.stringify(stabilize(value)) ?? 'null'
}

function stabilize(value: unknown): unknown {
	if (value === null || typeof value !== 'object') return value
	if (Array.isArray(value)) return value.map((v) => stabilize(v) ?? null)
	const entries = Object.entries(value as Record<string, unknown>)
		.filter(([, v]) => v !== undefined && typeof v !== 'function')
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
	return Object.fromEntries(entries.map(([k, v]) => [k, stabilize(v)]))
}

/** Canonical hash of an interaction payload for `assertSameCall`. */
export function payloadHash(value: unknown): string {
	return fnv1aHex(stableStringify(value))
}
