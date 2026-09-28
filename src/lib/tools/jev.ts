/**
 * `jev_decide` + `jev_match` — opt-in lib tools over the Decisions API.
 *
 * `jev_decide` is the parametric primitive: the model picks *which decision
 * to make* (state + questions), never how to phrase the call. `jev_match` is
 * the `is_same_product` noul convenience (mirrors `evaluate_product_match` in
 * `~/dev/arb2b/arbitrage_bot/engine/jev_matcher.py`, threshold 0.80).
 */

import type { AgentTool } from '../alfred/tools.js'
import { extractNoul, JevClient, type JevClientOptions } from '../jev/client.js'
import type { FetchFn, JevDecideInput, JevQuestion } from '../jev/types.js'

export interface JevToolDeps {
	fetchFn?: FetchFn
	apiKey?: string
	model?: string
	baseUrl?: string
	defaultTimeoutMs?: number
}

/** Build the client or throw a tool error when no key is configured. */
function clientOrThrow(deps: JevToolDeps): JevClient {
	if (!deps.apiKey) throw new Error('jev_decide: no API key configured')
	const opts: JevClientOptions = { apiKey: deps.apiKey }
	if (deps.model) opts.model = deps.model
	if (deps.baseUrl) opts.baseUrl = deps.baseUrl
	if (deps.fetchFn) opts.fetchFn = deps.fetchFn
	if (deps.defaultTimeoutMs !== undefined) opts.defaultTimeoutMs = deps.defaultTimeoutMs
	return new JevClient(opts)
}

function assertQuestionsShape(
	questions: unknown
): asserts questions is Record<string, JevQuestion> {
	if (!questions || typeof questions !== 'object' || Array.isArray(questions))
		throw new Error('jev_decide: questions must be a non-null object')
	for (const [id, q] of Object.entries(questions as Record<string, unknown>)) {
		const question = q as Partial<JevQuestion>
		if (!question || typeof question !== 'object')
			throw new Error(`jev_decide: questions[${JSON.stringify(id)}] must be an object`)
		if (question.type !== 'noul' && question.type !== 'choice')
			throw new Error(
				`jev_decide: questions[${JSON.stringify(id)}].type must be 'noul' or 'choice'`
			)
		if (typeof question.instructions !== 'string' || question.instructions.trim() === '')
			throw new Error(
				`jev_decide: questions[${JSON.stringify(id)}].instructions must be a non-empty string`
			)
	}
}

/** `AgentTool` wrapper: params `{ state, questions, model? }` → `{ answers }`. */
export function jevDecideTool(deps: JevToolDeps = {}): AgentTool {
	return {
		name: 'jev_decide',
		description:
			'Typed decision via the Jev Decisions API (noul P(true) / choice pick). Returns the raw answers map.',
		parameters: {
			type: 'object',
			properties: {
				state: {
					type: 'object',
					description: 'Decision state (dossier, source_item + candidates, ...)',
				},
				questions: {
					type: 'object',
					description: 'id → { type: noul|choice, instructions, criteria? }',
				},
				model: { type: 'string', description: 'Model override (OpenRouter endpoint only)' },
			},
			required: ['state', 'questions'],
		},
		execute: async (input, ctx) => {
			const { state, questions, model } = input as {
				state: unknown
				questions: unknown
				model?: unknown
			}
			assertQuestionsShape(questions)
			const decideInput: JevDecideInput = { state, questions }
			if (typeof model === 'string' && model.trim() !== '') decideInput.model = model
			const answers = await clientOrThrow(deps).decide(decideInput, ctx.signal)
			return { answers }
		},
	}
}

/** Match threshold, mirroring `MATCH_THRESHOLD` in `jev_matcher.py`. */
export const JEV_MATCH_THRESHOLD = 0.8

/**
 * `AgentTool` wrapper: params `{ a_title, b_title }` → `{ score, match }`.
 * Asks the `is_same_product` noul question (meaning after translation;
 * language difference alone is not a mismatch).
 */
export function jevMatchTool(deps: JevToolDeps = {}): AgentTool {
	return {
		name: 'jev_match',
		description:
			'P(both titles are the exact same physical product) via Jev noul (0..1, match ≥ 0.8).',
		parameters: {
			type: 'object',
			properties: {
				a_title: { type: 'string', description: 'First product title' },
				b_title: { type: 'string', description: 'Second product title' },
			},
			required: ['a_title', 'b_title'],
		},
		execute: async (input, ctx) => {
			const { a_title, b_title } = input as { a_title: unknown; b_title: unknown }
			if (typeof a_title !== 'string' || a_title.trim() === '')
				throw new Error('jev_match: a_title must be a non-empty string')
			if (typeof b_title !== 'string' || b_title.trim() === '')
				throw new Error('jev_match: b_title must be a non-empty string')
			const answers = await clientOrThrow(deps).decide(
				{
					state: `B2B Title: ${a_title}\nRetail Title: ${b_title}`,
					questions: {
						is_same_product: {
							type: 'noul',
							instructions:
								'Do these two product titles refer to the exact same physical product? ' +
								'Compare by MEANING after translation: titles may be in different languages ' +
								'- language difference alone is NOT a mismatch.',
							criteria: {
								true: 'Same brand, model, and variant (size/color/capacity) after translation; language ignored.',
								false: 'Different product, brand, model, or variant.',
							},
						},
					},
				},
				ctx.signal
			)
			const score = extractNoul(answers.is_same_product)
			return { score, match: score >= JEV_MATCH_THRESHOLD }
		},
	}
}
