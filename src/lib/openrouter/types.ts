/**
 * OpenRouter models-list types — `GET https://openrouter.ai/api/v1/models`.
 *
 * The wire is the contract: keys stay snake_case exactly as the server emits
 * them. No imports here — this module is types only, usable from browser + node.
 */

/** Injectable fetch, same convention as `alfred/types.ts` and `jev/types.ts`. */
export type FetchFn = typeof fetch

/** Per-token prices are decimal strings (e.g. `"0.000002"` = $2 / 1M tokens). */
export interface OpenRouterModelPricing {
	prompt: string
	completion: string
	request?: string
	image?: string
	web_search?: string
	internal_reasoning?: string
	input_cache_read?: string
	input_cache_write?: string
	[key: string]: string | undefined
}

export interface OpenRouterModelArchitecture {
	modality: string
	input_modalities: string[]
	output_modalities: string[]
	tokenizer: string
	instruct_type?: string | null
}

export interface OpenRouterModelTopProvider {
	context_length?: number | null
	max_completion_tokens?: number | null
	is_moderated?: boolean
}

/** One entry of the `GET /models` `data` array. Only `id` is guaranteed. */
export interface OpenRouterModel {
	id: string
	canonical_slug?: string
	hugging_face_id?: string | null
	name?: string
	created?: number
	description?: string
	context_length?: number
	architecture?: OpenRouterModelArchitecture
	pricing?: OpenRouterModelPricing
	top_provider?: OpenRouterModelTopProvider
	per_request_limits?: unknown
	supported_parameters?: string[]
	default_parameters?: Record<string, unknown>
}

/** Raw envelope of `GET https://openrouter.ai/api/v1/models`. */
export interface OpenRouterModelsResponse {
	data: OpenRouterModel[]
}
