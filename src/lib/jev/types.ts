/**
 * Jev transport types — typed decision-making over the Decisions API
 * (`~/dev/arb2b/arbitrage_bot/engine/jev_matcher.py` is the reference).
 *
 * Jev is NOT a chat LLM. The wire is:
 * - OpenRouter: `POST https://openrouter.ai/api/alpha/decisions`
 *   body `{ model, state, questions: { [id]: { type, instructions, criteria? } } }`
 * - Typesafe: `POST https://api.typesafe.ai/v1/systemone`
 *   body `{ state, questions }` (no `model`).
 *
 * Response: `{ answers: { [id]: answer } }` where a `noul` answer carries
 * `{ type: 'noul', noul: 0..1 }` and a `choice` answer carries
 * `{ choice, confidence?, scores? | probabilities? }`.
 *
 * Keys stay snake_case where they mirror the wire. No imports here — types
 * only, usable from browser + node.
 */

/** Injectable fetch (`typeof fetch`), same convention as `alfred` and `openrouter`. */
export type FetchFn = typeof fetch

/** Jev primitive type. `noul` = P(true) 0..1, `choice` = pick one candidate, `score` = ordinal level (Laya backends; Jev rejects it). */
export type JevQuestionType = 'noul' | 'choice' | 'score'

/** One question in the Decisions `questions` map. */
export interface JevQuestion {
	type: JevQuestionType
	/** What is being asked, e.g. "Do these two titles refer to the same product?" */
	instructions: string
	/** Per-candidate glosses for `choice` (`id` → description). */
	criteria?: Record<string, string>
}

/** Input to `POST /decisions`. `state` is opaque to the lib (any JSON). */
export interface JevDecideInput {
	/** Dossier / comparison state, e.g. `{ source_item, candidates }`. */
	state: unknown
	/** `id` → question. At least one entry. */
	questions: Record<string, JevQuestion>
	/** Model override for this call (OpenRouter endpoint only). */
	model?: string
}

/** Raw `answers` map from the Decisions response. */
export type JevAnswers = Record<string, unknown>

/** Decoded `noul` answer: P(true) in 0..1. */
export interface JevNoulAnswer {
	type: 'noul'
	noul: number
}

/** Decoded `choice` answer, normalized (`probabilities` → `scores`). */
export interface JevChoiceAnswer {
	choice: string
	confidence?: number
	scores?: Record<string, number>
}
