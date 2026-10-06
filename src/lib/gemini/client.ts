/**
 * Gemini model client wrapper
 */
import type { FetchFn } from '../openrouter/types.js'

export interface GeminiModel {
	name: string
	displayName: string
	description: string
}

export interface GeminiClientOptions {
	apiKey: string
	fetchFn?: FetchFn
}

export class GeminiClient {
	private readonly apiKey: string
	private readonly fetchFn: FetchFn

	constructor(opts: GeminiClientOptions) {
		if (!opts?.apiKey) throw new Error('apiKey is required')
		this.apiKey = opts.apiKey
		this.fetchFn = opts.fetchFn ?? fetch
	}

	async listModels(): Promise<GeminiModel[]> {
		const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${this.apiKey}`
		const res = await this.fetchFn(url)
		if (!res.ok) throw new Error(`Gemini API error: ${res.status}`)
		const json = await res.json()
		return (json as { models: GeminiModel[] }).models
	}
}
