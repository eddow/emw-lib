/**
 * Tool serving — the `emw` half of Alfred's callback contract
 * (`butler/alfred.md` §2.1, `plans/alfred-client.md` §9).
 *
 * One {@link AgentTool} produces **both** halves of the contract, so the
 * descriptor Alfred sees and the function `emw` runs cannot drift:
 *
 * - {@link toToolset} turns tools into the `toolset` sent on `POST /sessions`
 *   (every tool URL-free `callback` — Alfred POSTs to its env-owned webhook).
 * - {@link createToolHandler} is the webhook Alfred POSTs to: verify → dedupe
 *   → `202` → execute → PUT the result back to `/sessions/{id}/tool-callback`.
 *   Most hosts want `server.ts` (`createWebhookHandler`), which pre-wires the
 *   secret check around this core.
 *
 * Framework-free: no Svelte, no SvelteKit, no `node:` imports, no DB. The host
 * app injects `resolveScope` (its own lookup), `claim` (durable dedupe) and
 * `waitUntil` (Vercel's `waitUntil`, or fire-and-forget in tests).
 */

import type { AlfredClient } from './client.js'
import type { ToolsetConfig, ToolsetPolicy } from './types.js'

/** Default per-tool timeout, matching the `timeout_ms` in `butler/alfred.md` §2. */
export const DEFAULT_TOOL_TIMEOUT_MS = 15_000

/**
 * Execution context handed to {@link AgentTool.execute}. Carries the identity
 * of the call plus the host-resolved scope.
 */
export interface ToolScope {
	/** Alfred session id (from the wire). */
	sessionId: string
	/** Alfred tool call id (from the wire) — echo it back on the result. */
	toolCallId: string
	/** Tool name (from the wire). */
	name: string
	/** Aborts when the tool exceeds `timeoutMs`. */
	signal: AbortSignal
	/**
	 * Host-resolved scope for this session (chat, entity, …). Resolved by
	 * `resolveScope` from `sessionId` — **never** trusted from the wire.
	 */
	scope: Record<string, unknown>
}

/**
 * A tool the agent may call. `parameters` is JSON Schema; `execute` runs in
 * the host app (it may touch the DB — this module never does).
 */
export interface AgentTool<I = unknown, O = unknown> {
	name: string
	description: string
	parameters: { type: 'object'; properties: Record<string, unknown>; required?: string[] }
	execute: (input: I, ctx: ToolScope) => Promise<O>
}

/** Body Alfred POSTs to the webhook (`butler/alfred.md` §2.1). */
export interface ToolCallRequest {
	session_id: string
	tool_call_id: string
	name: string
	arguments?: unknown
}

export interface ToolHandlerOptions {
	/** The tools this handler serves. */
	tools: AgentTool[]
	/** Transport used to PUT the result back to Alfred. */
	client: AlfredClient
	/**
	 * `sessionId` → scope for {@link ToolScope.scope}. The host app owns the
	 * lookup (its session↔chat binding); the lib never reads the DB.
	 */
	resolveScope?: (sessionId: string) => Promise<Record<string, unknown>>
	/**
	 * Shared-secret check. Alfred is not a browser and has no salt cookie, so
	 * the webhook is a public route authenticated here. Return `false` → `401`.
	 */
	authorize?: (req: Request) => boolean | Promise<boolean>
	/**
	 * Atomically claim a `tool_call_id`. Return `false` when it was already
	 * handled → the handler answers `200` and does no work. Delivery is
	 * at-least-once, so production should back this with a durable store
	 * (the `webhook_events` insert-or-conflict pattern). Defaults to an
	 * in-memory set, which is per-instance only.
	 */
	claim?: (toolCallId: string) => Promise<boolean>
	/**
	 * Run work after the `202`. Pass Vercel's `waitUntil` in production;
	 * defaults to fire-and-forget.
	 */
	waitUntil?: (work: Promise<unknown>) => void
	/** Per-tool timeout in ms. Default {@link DEFAULT_TOOL_TIMEOUT_MS}. */
	timeoutMs?: number
}

/** Minimal JSON response helper (no SvelteKit import — this lib is portable). */
function json(body: unknown, status: number): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	})
}

/** Error message from an unknown thrown value. */
function message(err: unknown): string {
	return err instanceof Error ? err.message : String(err)
}

/** In-memory claim fallback — per-instance only; see {@link ToolHandlerOptions.claim}. */
function memoryClaim(): (toolCallId: string) => Promise<boolean> {
	const seen = new Set<string>()
	return async (toolCallId: string) => {
		if (seen.has(toolCallId)) return false
		seen.add(toolCallId)
		return true
	}
}

/**
 * Build the `toolset` for `POST /sessions`. Every tool is emitted as
 * `execution.type: 'callback'` with no per-tool URL — Alfred POSTs to its
 * env-owned `ALFRED_TOOL_WEBHOOK_URL` (`butler/alfred.md` §2.1), so dispatch
 * is by tool `name` only. `emw` runs on Vercel and cannot hold a connection,
 * so it never uses `http` (`plans/alfred-client.md` §0).
 *
 * `urlOverride` is an escape hatch for tests and stateless external `http`
 * tools; production `emw` sessions leave it unset.
 */
export function toToolset(
	tools: AgentTool[],
	policy?: ToolsetPolicy,
	timeoutMs: number = DEFAULT_TOOL_TIMEOUT_MS,
	urlOverride?: string
): ToolsetConfig {
	return {
		tools: tools.map((tool) => ({
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
			execution: {
				type: 'callback',
				...(urlOverride ? { url: urlOverride } : {}),
				timeout_ms: timeoutMs,
			},
		})),
		policy,
	}
}

/**
 * Build the webhook handler Alfred POSTs tool calls to.
 *
 * Contract (`butler/alfred.md` §2.1):
 * - bad secret → `401`; malformed body → `400`; already-claimed → `200` no-op.
 * - otherwise `202` immediately, then execute and PUT the result back.
 * - unknown tool and throwing tool both go back as `{ error }` (Alfred turns
 *   them into `is_error` tool results so the model can recover) — never a 5xx.
 */
export function createToolHandler(opts: ToolHandlerOptions): (req: Request) => Promise<Response> {
	const byName = new Map<string, AgentTool>(opts.tools.map((t) => [t.name, t]))
	const claim = opts.claim ?? memoryClaim()
	const waitUntil = opts.waitUntil ?? ((work: Promise<unknown>) => void work)
	const timeoutMs = opts.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS

	/** Execute one tool and PUT the outcome back to Alfred. Never throws. */
	async function run(call: ToolCallRequest): Promise<void> {
		const { session_id, tool_call_id, name } = call
		const tool = byName.get(name)
		if (!tool) {
			await reply(session_id, tool_call_id, { error: `unknown tool: ${name}` })
			return
		}
		const ac = new AbortController()
		const timer = setTimeout(() => ac.abort(), timeoutMs)
		try {
			const scope = opts.resolveScope ? await opts.resolveScope(session_id) : {}
			const result = await tool.execute(call.arguments ?? {}, {
				sessionId: session_id,
				toolCallId: tool_call_id,
				name,
				signal: ac.signal,
				scope,
			})
			await reply(session_id, tool_call_id, { result })
		} catch (err) {
			await reply(session_id, tool_call_id, { error: message(err) })
		} finally {
			clearTimeout(timer)
		}
	}

	/** PUT the outcome to `/sessions/{id}/tool-callback`, swallowing transport errors. */
	async function reply(
		sessionId: string,
		toolCallId: string,
		outcome: { result?: unknown; error?: string }
	): Promise<void> {
		try {
			await opts.client.toolCallback(sessionId, { tool_call_id: toolCallId, ...outcome })
		} catch {
			// Alfred's timeout will resolve the call as an error; nothing to do here.
		}
	}

	return async (req: Request): Promise<Response> => {
		if (opts.authorize && !(await opts.authorize(req))) {
			return json({ error: 'unauthorized' }, 401)
		}

		let body: Partial<ToolCallRequest>
		try {
			body = (await req.json()) as Partial<ToolCallRequest>
		} catch {
			return json({ error: 'invalid JSON' }, 400)
		}

		const { session_id, tool_call_id, name } = body ?? {}
		if (
			typeof session_id !== 'string' ||
			session_id === '' ||
			typeof tool_call_id !== 'string' ||
			tool_call_id === '' ||
			typeof name !== 'string' ||
			name === ''
		) {
			return json({ error: 'malformed request' }, 400)
		}

		if (!(await claim(tool_call_id))) {
			return json({ ok: true, deduped: true }, 200)
		}

		// Defer the start so the 202 is genuinely returned before any work runs
		// (an async function body runs synchronously up to its first `await`).
		waitUntil(
			Promise.resolve().then(() =>
				run({ session_id, tool_call_id, name, arguments: body.arguments })
			)
		)
		return json({ ok: true }, 202)
	}
}
