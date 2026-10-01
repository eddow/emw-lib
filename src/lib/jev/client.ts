/**
 * Jev client — typed decision-making over the Decisions API
 * (`~/dev/arb2b/arbitrage_bot/engine/jev_matcher.py` is the reference).
 *
 * Jev is NOT a chat LLM: there are no messages, no `response_format`, no
 * temperature. The client POSTs `{ model?, state, questions }` and returns
 * the raw `answers` map; decoding (`noul` → number, `choice` → pick) is left
 * to the caller (see `extractNoul` / `extractChoice`).
 *
 * Framework-agnostic: no Svelte, no `node:` imports, no env reads. All network
 * I/O goes through an injectable {@link FetchFn} (defaults to global `fetch`)
 * so tests can pass a mock and never touch a live endpoint.
 *
 * The `apiKey` is a constructor arg — `emw` resolves it from private env
 * (`$env/dynamic/private`, server-only, never to the browser). Every failure
 * — transport, non-2xx, timeout, validation, parse — surfaces as a
 * {@link JevError}; callers never see a raw `Response`.
 */

import type { FetchFn, JevAnswers, JevChoiceAnswer, JevDecideInput, JevQuestion } from './types.js'

/** OpenRouter Decisions endpoint (takes `model` in the body). */
export const JEV_OPENROUTER_URL = 'https://openrouter.ai/api/alpha/decisions'

/** Typesafe endpoint (no `model` in the body). */
export const JEV_TYPESAFE_URL = 'https://api.typesafe.ai/v1/systemone'

/** Default model for the OpenRouter endpoint. */
export const JEV_MODEL = 'typesafe/jev-1.13'

/** Default per-request timeout (ms) when no `signal` is supplied. */
export const JEV_DEFAULT_TIMEOUT_MS = 30_000

export interface JevClientOptions {
	/**
	 * API key. Server-only; `emw` passes `env.OPENROUTER_API_KEY` (or the
	 * Typesafe key when pointing at {@link JEV_TYPESAFE_URL}).
	 * Required — the client throws `validation` without it.
	 */
	apiKey: string
	/** Model id for the OpenRouter endpoint. Defaults to {@link JEV_MODEL}. */
	model?: string
	/**
	 * Decisions endpoint URL. Defaults to {@link JEV_OPENROUTER_URL}.
	 * Use {@link JEV_TYPESAFE_URL} for the Typesafe endpoint (the `model`
	 * is then omitted from the body). Trailing slashes trimmed.
	 */
	baseUrl?: string
	/** Injectable fetch, default global `fetch`. */
	fetchFn?: FetchFn
	/** Default timeout in ms, default {@link JEV_DEFAULT_TIMEOUT_MS}. A per-call `signal` wins. */
	defaultTimeoutMs?: number
}

/** Single error type for the whole client. */
export class JevError extends Error {
	/** HTTP status when the failure came from a response. */
	status?: number
	/** Machine-readable code: `validation` | `http` | `timeout` | `aborted` | `network` | `parse`. */
	code: string
	/** Server-provided detail (parsed body when available). */
	detail?: unknown

	constructor(
		message: string,
		opts: { status?: number; code: string; detail?: unknown } = { code: 'network' }
	) {
		super(message)
		this.name = 'JevError'
		this.status = opts.status
		this.code = opts.code
		this.detail = opts.detail
	}
}

/** Throw a validation error before any network call. */
function invalid(message: string): never {
	throw new JevError(message, { code: 'validation' })
}

/** `questions` must hold at least 1 question with a valid primitive type. */
function assertQuestions(questions: JevDecideInput['questions']): void {
	if (!questions || typeof questions !== 'object' || Array.isArray(questions))
		invalid('questions must be a non-null object')
	const ids = Object.keys(questions)
	if (ids.length < 1) invalid('questions must hold at least 1 question')
	for (const id of ids) {
		const q = (questions as Record<string, JevQuestion>)[id]
		if (!q || typeof q !== 'object') invalid(`questions[${JSON.stringify(id)}] must be an object`)
		if (q.type !== 'noul' && q.type !== 'choice' && q.type !== 'score')
			invalid(`questions[${JSON.stringify(id)}].type must be 'noul', 'choice' or 'score' (score = Laya-only)`) 
		if (typeof q.instructions !== 'string' || q.instructions.trim() === '')
			invalid(`questions[${JSON.stringify(id)}].instructions must be a non-empty string`)
	}
}

/**
 * Pull the `is_same_product`-style probability out of a Decisions answer.
 * Accepts `{ type: 'noul', noul: n }` and the plain-number form. Returns
 * `0` when the shape is unrecognized (mirrors `_extract_score`).
 */
export function extractNoul(answer: unknown): number {
	try {
		if (typeof answer === 'number') return answer
		if (answer && typeof answer === 'object' && !Array.isArray(answer)) {
			const node = answer as Record<string, unknown>
			if ('noul' in node) return Number(node.noul)
		}
	} catch {
		// fall through to 0
	}
	const n = typeof answer === 'number' ? answer : NaN
	return Number.isFinite(n) ? (n as number) : 0
}

/**
 * Normalize a `choice` answer to `{ choice, confidence?, scores? }`.
 * `probabilities` (when present) becomes `scores` (mirrors
 * `_extract_batch_answer`). Returns `{}` when the shape is unrecognized.
 */
export function extractChoice(answer: unknown): Partial<JevChoiceAnswer> {
	try {
		if (typeof answer === 'string') return { choice: answer }
		if (answer && typeof answer === 'object' && !Array.isArray(answer)) {
			const node = answer as Record<string, unknown>
			if (typeof node.choice !== 'string') return {}
			const out: Partial<JevChoiceAnswer> = { choice: node.choice }
			if (typeof node.confidence === 'number') out.confidence = node.confidence
			const scores = node.scores
			const probs = node.probabilities
			const src =
				scores && typeof scores === 'object' && !Array.isArray(scores)
					? (scores as Record<string, unknown>)
					: probs && typeof probs === 'object' && !Array.isArray(probs)
						? (probs as Record<string, unknown>)
						: undefined
			if (src) {
				try {
					out.scores = Object.fromEntries(Object.entries(src).map(([k, v]) => [k, Number(v)]))
				} catch {
					// leave scores unset
				}
			}
			return out
		}
	} catch {
		// fall through to {}
	}
	return {}
}

export class JevClient {
	private readonly apiKey: string
	private readonly model: string
	private readonly baseUrl: string
	private readonly fetchFn: FetchFn
	private readonly defaultTimeoutMs: number

	constructor(opts: JevClientOptions) {
		if (!opts?.apiKey) invalid('apiKey is required')
		this.apiKey = opts.apiKey
		this.model = opts.model ?? JEV_MODEL
		this.baseUrl = (opts.baseUrl ?? JEV_OPENROUTER_URL).replace(/\/+$/, '')
		this.fetchFn = opts.fetchFn ?? fetch
		this.defaultTimeoutMs = opts.defaultTimeoutMs ?? JEV_DEFAULT_TIMEOUT_MS
	}

	/** `true` when the endpoint is the Typesafe one (body carries no `model`). */
	private isTypesafe(): boolean {
		return this.baseUrl.includes('typesafe.ai')
	}

	/**
	 * Run one Decisions call. Returns the raw `answers` map
	 * (`{ [id]: answer }`); decode with {@link extractNoul} /
	 * {@link extractChoice}.
	 */
	async decide(input: JevDecideInput, signal?: AbortSignal): Promise<JevAnswers> {
		if (!input || typeof input !== 'object') invalid('input must be an object')
		assertQuestions(input.questions)
		const body: Record<string, unknown> = {
			state: input.state,
			questions: input.questions,
		}
		// The Typesafe endpoint takes no `model`; OpenRouter requires one.
		if (!this.isTypesafe()) body.model = input.model ?? this.model
		const res = await this.send(body, signal)
		if (!res.ok) throw await this.httpError(res)
		let json: unknown
		try {
			json = await res.json()
		} catch (err) {
			throw new JevError(`invalid JSON response: ${(err as Error).message}`, { code: 'parse' })
		}
		if (!json || typeof json !== 'object' || Array.isArray(json))
			throw new JevError('response must be a JSON object', { code: 'parse', detail: json })
		const answers = (json as { answers?: unknown }).answers ?? json
		if (!answers || typeof answers !== 'object' || Array.isArray(answers))
			throw new JevError('response has no answers map', { code: 'parse', detail: json })
		return answers as JevAnswers
	}

	/** Perform a fetch with timeout/abort handling, mapping failures to {@link JevError}. */
	private async send(body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
		let controller: AbortController | undefined
		let timer: ReturnType<typeof setTimeout> | undefined
		let timedOut = false
		const effectiveTimeout = signal ? undefined : this.defaultTimeoutMs
		if (effectiveTimeout !== undefined) {
			controller = new AbortController()
			const ms = effectiveTimeout
			timer = setTimeout(() => {
				timedOut = true
				controller?.abort()
			}, ms)
		}
		try {
			return await this.fetchFn(this.baseUrl, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					authorization: `Bearer ${this.apiKey}`,
				},
				body: JSON.stringify(body),
				signal: signal ?? controller?.signal,
			})
		} catch (err) {
			if (timedOut)
				throw new JevError(`request timed out after ${this.defaultTimeoutMs}ms`, {
					code: 'timeout',
				})
			if (signal?.aborted) throw new JevError('request aborted', { code: 'aborted' })
			throw new JevError(`network error: ${(err as Error).message}`, {
				code: 'network',
				detail: err,
			})
		} finally {
			if (timer) clearTimeout(timer)
		}
	}

	/** Build a {@link JevError} from a non-2xx response, reading its body when possible. */
	private async httpError(res: Response): Promise<JevError> {
		let detail: unknown
		try {
			const text = await res.text()
			detail = text ? JSON.parse(text) : undefined
		} catch {
			detail = undefined
		}
		const message =
			(detail && typeof detail === 'object' && 'error' in detail
				? String((detail as { error: unknown }).error)
				: undefined) ?? `HTTP ${res.status} ${res.statusText}`
		return new JevError(message, { status: res.status, code: 'http', detail })
	}
}
