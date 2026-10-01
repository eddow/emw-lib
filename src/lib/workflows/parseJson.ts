/**
 * `wf.parseJson` — deterministic extraction + parse + validation
 * (see `docs/workflows/README.md`).
 *
 * Client-safe: no `node:` imports, no env reads. Pure and deterministic —
 * safe in workflow code, re-runs every tick identically. No `Date`,
 * `Math.random`, locale, ambient state, `eval`, or `new Function`.
 *
 * Escalation ladder (first success wins):
 * 1. `JSON.parse(raw)` — the answer is already clean JSON.
 * 2. Strip markdown fences (```` ```json … ``` ````), retry each block.
 * 3. Extract the first balanced `{…}` / `[…]` (string/escape aware), parse.
 * 4. `schema.safeParse` the parsed value; on failure throw `ParseError`.
 *
 * Throws `ParseError` (a normal, catchable `Error`) — never a
 * control-flow sentinel. Retry is a *new* interaction (new idx).
 */

import type { SchemaLike } from './types.js'
import { ParseError } from './types.js'

/** Bodies of all markdown fences in `text` (info string optional). */
function fenceBlocks(text: string): string[] {
	const out: string[] = []
	const re = /```(?:json)?[ \t]*\n?([\s\S]*?)```/g
	let m: RegExpExecArray | null
	while ((m = re.exec(text)) !== null) out.push(m[1])
	return out
}

/**
 * First balanced `{…}` or `[…]` substring, string/escape aware.
 * Starts at the earliest `{`/`[`; returns `null` when never balanced.
 */
export function extractBalanced(text: string): string | null {
	const openIdx = findOpener(text)
	if (openIdx === null) return null
	const open = text[openIdx]
	const close = open === '{' ? '}' : ']'
	let depth = 0
	let inString = false
	let escape = false
	for (let i = openIdx; i < text.length; i++) {
		const ch = text[i]
		if (inString) {
			if (escape) escape = false
			else if (ch === '\\') escape = true
			else if (ch === '"') inString = false
			continue
		}
		if (ch === '"') inString = true
		else if (ch === open) depth++
		else if (ch === close) {
			depth--
			if (depth === 0) return text.slice(openIdx, i + 1)
		}
	}
	return null
}

function findOpener(text: string): number | null {
	const brace = text.indexOf('{')
	const bracket = text.indexOf('[')
	if (brace === -1) return bracket === -1 ? null : bracket
	if (bracket === -1) return brace
	return Math.min(brace, bracket)
}

function tryParse(text: string): { ok: true; value: unknown } | { ok: false } {
	try {
		return { ok: true, value: JSON.parse(text) }
	} catch {
		return { ok: false }
	}
}

/**
 * Extract the JSON value from a possibly prose-wrapped answer.
 * Throws `ParseError` when no JSON value is found.
 */
export function extractJsonValue(raw: string): unknown {
	const text = raw.trim()
	const direct = tryParse(text)
	if (direct.ok) return direct.value
	for (const block of fenceBlocks(text)) {
		const parsed = tryParse(block.trim())
		if (parsed.ok) return parsed.value
	}
	const balanced = extractBalanced(text)
	if (balanced !== null) {
		const parsed = tryParse(balanced)
		if (parsed.ok) return parsed.value
	}
	for (const block of fenceBlocks(text)) {
		const inner = extractBalanced(block)
		if (inner !== null) {
			const parsed = tryParse(inner)
			if (parsed.ok) return parsed.value
		}
	}
	throw new ParseError('no JSON value found in answer')
}

/**
 * Deterministic extraction + parse + schema validation.
 * Throws `ParseError` (catchable, not a sentinel) on failure.
 */
export function parseJson<T>(raw: string, schema: SchemaLike<T>): T {
	const value = extractJsonValue(raw)
	const res = schema.safeParse(value)
	if (res.success) return res.data
	throw new ParseError('answer does not match schema', (res as { error: unknown }).error)
}
