/**
 * Workflow static checks (checklist 9.2–9.3, specs §§6, 9.1, 9.7).
 *
 * Client-safe: no `node:` imports, no env reads. Pure source-text
 * analysis — the host reads the workflow file and calls {@link checkWorkflow}
 * at deploy time (or in CI). Two checks:
 *
 * - Exhaustiveness (9.2): every code path of the workflow function must
 *   `return` or `throw` (the runtime W-O `outputSchema` check in `tick()`
 *   covers the taken branch; this lint covers the branches never taken).
 *   Heuristic over the function source: counts `return`/`throw`
 *   statements outside nested functions, requires at least one, and
 *   flags `if` without `else` + no trailing return as a likely missing
 *   path. Heuristic, not a proof — the runtime check is authoritative.
 * - Determinism (9.3): no `Date`, `Math.random`, `fetch`, or DB imports
 *   in workflow files outside `once`. Flags `Date.` / `Math.random(` /
 *   `fetch(` / `neon(` / `sql`` ` outside `once('…', …)` spans, plus
 *   imports of `fetch`-like, DB-client and `node:` modules.
 *
 * Both return lists of findings (empty = clean). Never throws on
 * unparseable input — reports a single `unparseable` finding instead.
 */

export interface WorkflowCheckFinding {
	rule: 'exhaustiveness' | 'determinism'
	message: string
	line?: number
}

export interface WorkflowCheckResult {
	ok: boolean
	findings: WorkflowCheckFinding[]
}

/** Strip comments only (strings intact) — for the import scan. */
function stripComments(src: string): string {
	return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^\\])\/\/[^\n]*/g, '$1 ')
}

/** Strip comments + string literals so keyword scans don't false-positive. */
function stripNoise(src: string): string {
	return stripComments(src)
		.replace(/'(?:[^'\\]|\\.)*'/g, "''")
		.replace(/"(?:[^"\\]|\\.)*"/g, '""')
		.replace(/`(?:[^`\\]|\\.)*`/g, '``')
}

/** Line number of `offset` in `src` (1-based). */
function lineOf(src: string, offset: number): number {
	return src.slice(0, offset).split('\n').length
}

/**
 * Spans of `once('key', …)` / `now()` calls in the stripped source —
 * determinism violations inside these spans are allowed (§2.3).
 */
function onceSpans(stripped: string): [number, number][] {
	const spans: [number, number][] = []
	const re = /\b(?:once|now)\s*\(/g
	let m: RegExpExecArray | null
	while ((m = re.exec(stripped)) !== null) {
		// Balance parens from the opening `(`.
		let depth = 0
		let i = m.index + m[0].length - 1
		for (; i < stripped.length; i++) {
			if (stripped[i] === '(') depth++
			else if (stripped[i] === ')') {
				depth--
				if (depth === 0) break
			}
		}
		spans.push([m.index, i])
	}
	return spans
}

function insideSpans(spans: [number, number][], offset: number): boolean {
	return spans.some(([a, b]) => offset >= a && offset <= b)
}

/** Exhaustiveness lint (9.2): `return`/`throw` on all paths. */
function checkExhaustiveness(src: string, stripped: string): WorkflowCheckFinding[] {
	const findings: WorkflowCheckFinding[] = []
	// Function bodies to check: `export async function name(…) { … }`,
	// block-bodied `const name = async (…) => { … }` and its
	// `export const name = async (…) => { … }` form. The param list is
	// matched as `[^)]*` (no nested parens — defaults with calls are rare
	// in workflow signatures; the runtime W-O check stays authoritative).
	// Nested function bodies are excluded from the outer count (their
	// returns don't satisfy the outer).
	const fnRe =
		/(?:export\s+)?async\s+function\s+\w+\s*\([^)]*\)\s*\{|(?:export\s+)?(?:const|let|var)\s+\w+\s*=\s*async\s*\([^)]*\)\s*=>\s*\{/g
	let m: RegExpExecArray | null
	let checked = 0
	while ((m = fnRe.exec(stripped)) !== null) {
		checked++
		// The regex ends with the body's opening `\{` — it is the last
		// char of the match (NOT the first `{` after `m.index`, which
		// would be a destructured param).
		const open = m.index + m[0].length - 1
		let depth = 0
		let end = open
		for (let i = open; i < stripped.length; i++) {
			if (stripped[i] === '{') depth++
			else if (stripped[i] === '}') {
				depth--
				if (depth === 0) {
					end = i
					break
				}
			}
		}
		const body = stripped.slice(open, end)
		// Remove nested function bodies (their returns don't count).
		// Collect spans against `body` first, then filter — offsets stay valid.
		const nestedRe = /function\s*\([^)]*\)\s*\{|=>\s*\{/g
		const spans: [number, number][] = []
		let nm: RegExpExecArray | null
		while ((nm = nestedRe.exec(body)) !== null) {
			const nOpen = nm.index + nm[0].length - 1
			let nDepth = 0
			let nEnd = nOpen
			for (let i = nOpen; i < body.length; i++) {
				if (body[i] === '{') nDepth++
				else if (body[i] === '}') {
					nDepth--
					if (nDepth === 0) {
						nEnd = i
						break
					}
				}
			}
			spans.push([nm.index, nEnd])
		}
		let bodyStripped = ''
		let cursor = 0
		for (const [a, b] of spans) {
			bodyStripped += `${body.slice(cursor, a)} `
			cursor = b
		}
		bodyStripped += body.slice(cursor)
		const returns = (bodyStripped.match(/\breturn\b/g) ?? []).length
		const throws = (bodyStripped.match(/\bthrow\b/g) ?? []).length
		if (returns + throws === 0) {
			findings.push({
				rule: 'exhaustiveness',
				message: 'workflow function has no return/throw — every path must return W-O or throw',
				line: lineOf(src, m.index),
			})
			continue
		}
		// `if` without `else` and no trailing return: likely missing path.
		// (Arrow-concise bodies `=> expr` return implicitly — but those
		// never match `fnRe`'s `\{` form, so reaching here means a block.)
		const ifs = (bodyStripped.match(/\bif\s*\(/g) ?? []).length
		const elses = (bodyStripped.match(/\belse\b/g) ?? []).length
		const trimmed = bodyStripped.trim()
		// Trailing return/throw: the last statement before the closing
		// brace is a return/throw (allows trailing `}` of inner blocks).
		const trailing = /(?:return|throw)\b[^;{}]*(?:;?\s*\}?)*\s*$/.test(trimmed)
		if (ifs > elses && !trailing) {
			findings.push({
				rule: 'exhaustiveness',
				message: 'branching without else and no trailing return — a path may miss W-O',
				line: lineOf(src, m.index),
			})
		}
	}
	if (checked === 0) {
		findings.push({ rule: 'exhaustiveness', message: 'no async workflow function found' })
	}
	return findings
}

/** Determinism lint (9.3): no clock/random/IO outside `once`. */
function checkDeterminism(src: string, stripped: string): WorkflowCheckFinding[] {
	const findings: WorkflowCheckFinding[] = []
	const spans = onceSpans(stripped)
	const patterns: { re: RegExp; message: string }[] = [
		{ re: /\bDate\b/g, message: 'Date outside wf.once — use wf.now() or wf.once' },
		{
			re: /\bMath\s*\.\s*random\s*\(/g,
			message: 'Math.random() outside wf.once — journal it via wf.once',
		},
		{ re: /\bfetch\s*\(/g, message: 'fetch() outside wf.once — route I/O through wf.use.*' },
		{ re: /\bneon\s*\(/g, message: 'neon() outside wf.once — workflow code must not touch the DB' },
		{
			re: /\b(?:createClient|createPool)\s*\(/g,
			message: 'DB client construction outside wf.once — workflow code must not touch the DB',
		},
	]
	for (const { re, message } of patterns) {
		let m: RegExpExecArray | null
		while ((m = re.exec(stripped)) !== null) {
			if (!insideSpans(spans, m.index)) {
				findings.push({ rule: 'determinism', message, line: lineOf(src, m.index) })
			}
		}
	}
	// Banned imports: fetch-like, DB clients, node: builtins. Scanned on
	// comment-stripped source (module specifiers are strings — the
	// noise-stripped form would hide them).
	const importRe = /import\s+(?:[^'"]*from\s+)?['"]([^'"]+)['"]/g
	let im: RegExpExecArray | null
	const importSrc = stripComments(src)
	while ((im = importRe.exec(importSrc)) !== null) {
		const spec = im[1]
		if (
			spec === 'node:fetch' ||
			/^node:/.test(spec) ||
			/neon|postgres|\bpg\b|drizzle|kysely|prisma/i.test(spec)
		) {
			findings.push({
				rule: 'determinism',
				message: `banned import '${spec}' in workflow file — I/O goes through wf.use.*`,
				line: lineOf(src, im.index),
			})
		}
	}
	return findings
}

/**
 * Run both static checks over a workflow file's source. Empty findings =
 * clean. Never throws — unparseable input yields one `unparseable`
 * finding.
 */
export function checkWorkflow(src: string): WorkflowCheckResult {
	try {
		const stripped = stripNoise(src)
		const findings = [...checkExhaustiveness(src, stripped), ...checkDeterminism(src, stripped)]
		return { ok: findings.length === 0, findings }
	} catch {
		return { ok: false, findings: [{ rule: 'exhaustiveness', message: 'unparseable source' }] }
	}
}
