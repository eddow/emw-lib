/**
 * OpenRouter models-list client — `GET https://openrouter.ai/api/v1/models`
 * with the API key in the `Authorization` header.
 *
 * Framework-agnostic: no Svelte, no `node:` imports, no env reads. All network
 * I/O goes through an injectable {@link FetchFn} (defaults to global `fetch`)
 * so tests can pass a mock and never touch the live endpoint.
 *
 * The `apiKey` is a constructor arg — `emw` resolves it from private env
 * (`$env/dynamic/private`, server-only, never to the browser). Every failure
 * — transport, non-2xx, timeout, validation, parse — surfaces as an
 * {@link OpenRouterError}; callers never see a raw `Response`.
 */

import type { FetchFn, OpenRouterModel } from './types.js'

/** OpenRouter models-list endpoint. */
export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1'
export const OPENROUTER_MODELS_URL = `${OPENROUTER_BASE_URL}/models`
export const OPENROUTER_KEY_INFO_URL = `${OPENROUTER_BASE_URL}/key`
export const OPENROUTER_CREDITS_INFO_URL = `${OPENROUTER_BASE_URL}/credits`

/** Default per-request timeout (ms) when no `signal` is supplied. */
export const OPENROUTER_DEFAULT_TIMEOUT_MS = 30_000

export interface OpenRouterClientOptions {
	/**
	 * API key. Server-only; `emw` passes `env.OPENROUTER_API_KEY`.
	 * Required — the client throws `validation` without it.
	 */
	apiKey: string
	/**
	 * Models-list endpoint URL. Defaults to {@link OPENROUTER_MODELS_URL}.
	 * Trailing slashes trimmed.
	 */
	modelsUrl?: string
	/** Injectable fetch, default global `fetch`. */
	fetchFn?: FetchFn
	/** Default timeout in ms, default {@link OPENROUTER_DEFAULT_TIMEOUT_MS}. A per-call `signal` wins. */
	defaultTimeoutMs?: number
}

/** Single error type for the whole client. */
export class OpenRouterError extends Error {
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
		this.name = 'OpenRouterError'
		this.status = opts.status
		this.code = opts.code
		this.detail = opts.detail
	}
}

/** Throw a validation error before any network call. */
function invalid(message: string): never {
	throw new OpenRouterError(message, { code: 'validation' })
}

export class OpenRouterClient {
	private readonly apiKey: string
	private readonly baseUrl: string
	private readonly fetchFn: FetchFn
	private readonly defaultTimeoutMs: number

	constructor(opts: OpenRouterClientOptions) {
		if (!opts?.apiKey) invalid('apiKey is required')
		this.apiKey = opts.apiKey
		this.baseUrl = (opts.modelsUrl ?? OPENROUTER_MODELS_URL).replace(/\/+$/, '')
		this.fetchFn = opts.fetchFn ?? fetch
		this.defaultTimeoutMs = opts.defaultTimeoutMs ?? OPENROUTER_DEFAULT_TIMEOUT_MS
	}

	/**
	 * List all models (`GET {baseUrl}` with `Authorization: Bearer <key>`).
	 * Returns the raw `data` array; only `id` is guaranteed per entry.
	 */
	async listModels(signal?: AbortSignal): Promise<OpenRouterModel[]> {
		const res = await this.send(signal)
		if (!res.ok) throw await this.httpError(res)
		let json: unknown
		try {
			json = await res.json()
		} catch (err) {
			throw new OpenRouterError(`invalid JSON response: ${(err as Error).message}`, {
				code: 'parse',
			})
		}
		if (!json || typeof json !== 'object' || Array.isArray(json))
			throw new OpenRouterError('response must be a JSON object', { code: 'parse', detail: json })
		const data = (json as { data?: unknown }).data
		if (!Array.isArray(data))
			throw new OpenRouterError('response has no data array', { code: 'parse', detail: json })
		return data as OpenRouterModel[]
	}

	/** Perform a fetch with timeout/abort handling, mapping failures to {@link OpenRouterError}. */
	private async send(signal?: AbortSignal): Promise<Response> {
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
				method: 'GET',
				headers: {
					authorization: `Bearer ${this.apiKey}`,
				},
				signal: signal ?? controller?.signal,
			})
		} catch (err) {
			if (timedOut)
				throw new OpenRouterError(`request timed out after ${this.defaultTimeoutMs}ms`, {
					code: 'timeout',
				})
			if (signal?.aborted) throw new OpenRouterError('request aborted', { code: 'aborted' })
			throw new OpenRouterError(`network error: ${(err as Error).message}`, {
				code: 'network',
				detail: err,
			})
		} finally {
			if (timer) clearTimeout(timer)
		}
	}

	/** Build an {@link OpenRouterError} from a non-2xx response, reading its body when possible. */
	private async httpError(res: Response): Promise<OpenRouterError> {
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
		return new OpenRouterError(message, { status: res.status, code: 'http', detail })
	}
	async keyInfo() {
		const rv = await this.fetchFn(OPENROUTER_KEY_INFO_URL, {
			method: 'GET',
			headers: {
				authorization: `Bearer ${this.apiKey}`,
			},
		})
		return (await rv.json())?.data
	}
	async creditsInfo() {
		const rv = await this.fetchFn(OPENROUTER_CREDITS_INFO_URL, {
			method: 'GET',
			headers: {
				authorization: `Bearer ${this.apiKey}`,
			},
		})
		return (await rv.json())?.data
	}
	async remaining() {
		const keyInfo = await this.keyInfo()
		const creditInfo = await this.creditsInfo()
		return {
			free: keyInfo.is_free_tier
				? keyInfo.is_free_tier.limit_remaining
				: keyInfo.free_model_daily_requests.remaining,
			credits: creditInfo.total_credits - creditInfo.total_usage,
		}
	}
}
