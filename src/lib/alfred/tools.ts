/**
 * Tool serving — the `emw` half of Alfred's callback contract
 * (see `butler/docs/alfred.md` §2.1).
 *
 * One {@link AgentTool} produces **both** halves of the contract, so the
 * descriptor Alfred sees and the function `emw` runs cannot drift:
 *
 * - {@link toToolset} turns tools into the URL-free `toolset` sent on
 *   `POST /sessions` (Alfred POSTs to the generation's `webhook_url`).
 * - {@link createToolHandler} is the webhook Alfred POSTs to: verify →
 *   execute INLINE → return `{result} | {error}` in the POST response.
 *   No `202`, no `waitUntil`, no claim, no PUT-back (§8.1). Most hosts want
 *   `server.ts` (`createWebhookHandler`), which pre-wires the secret check.
 *
 * Framework-free: no Svelte, no SvelteKit, no `node:` imports, no DB. The host
 * app injects `resolveScope` (its own lookup).
 */

import type { ToolDef, ToolsetConfig, ToolsetPolicy } from './types.js'

/** Default per-tool timeout, matching the `timeout_ms` in `butler/alfred.md` §2. */
export const DEFAULT_TOOL_TIMEOUT_MS = 15_000

/** Execution context handed to {@link AgentTool.execute}. Carries the identity
 * of the call plus the host-resolved scope.
 */
export interface ToolScope {
	/** Alfred session id (from the wire). */
	sessionId: string
	/** Generation id (from the wire) — passed into scope, logged, never trusted. */
	generationId: string
	/** Alfred tool call id (from the wire). */
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

/** Body Alfred POSTs to the webhook (see `butler/docs/alfred.md` §2.1). */
export interface ToolCallRequest {
	session_id: string
	generation_id: string
	tool_call_id: string
	name: string
	arguments?: unknown
}

export interface ToolHandlerOptions {
	/** The tools this handler serves. */
	tools: AgentTool[]
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

/**
 * Build the `toolset` for `POST /sessions`. Every tool is emitted as
 * URL-free `execution.type: 'callback'` — Alfred POSTs to the generation's
 * `webhook_url` (see `butler/docs/alfred.md` §2.1), so dispatch is by tool `name`
 * only. Use {@link toBuiltinToolset} (or {@link toMixedToolset} to mix
 * hard-coded builtins with webhook-defined callbacks in one call) for tools
 * Alfred executes in-process (`builtin`, butler `docs/tools.md` §§3–4) and
 * {@link toPromptTool} for `emw`-defined sidecars Alfred executes
 * (`prompt`, §7).
 *
 * Callback tools MUST be idempotent (read-only lookups by contract, §8):
 * re-emission on `resume`/retry is safe ONLY under this rule. Side-effecting
 * operations are FORBIDDEN as `callback` tools in v1.
 */
export function toToolset(
	tools: AgentTool[],
	policy?: ToolsetPolicy,
	timeoutMs: number = DEFAULT_TOOL_TIMEOUT_MS
): ToolsetConfig {
	return {
		tools: tools.map((tool) => ({
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
			execution: {
				type: 'callback',
				timeout_ms: timeoutMs,
			},
		})),
		policy,
	}
}

/** A builtin tool Alfred executes in-process (butler `docs/tools.md` §§3–4). */
export interface BuiltinToolDef {
	name: string
	description: string
	parameters: { type: 'object'; properties: Record<string, unknown>; required?: string[] }
}

/**
 * Build `ToolDef[]` entries with `execution.type: 'builtin'` for tools
 * Alfred runs in-process — no `AgentTool.execute`, no webhook round-trip.
 * Unknown `builtin` names resolve as `is_error` tool results, never 5xx.
 */
export function toBuiltinToolset(tools: BuiltinToolDef[]): ToolDef[] {
	return tools.map((tool) => ({
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
		execution: { type: 'builtin' },
	}))
}

export interface PromptToolDef extends BuiltinToolDef {
	/** Alias allowlist: `text | extract | vision | jev` (butler §7). */
	alias: 'text' | 'extract' | 'vision' | 'jev'
	/** Session-fixed templates (strict `{{name}}` / `{{name|json}}` subset). */
	system_template: string
	user_template: string
	response_format?: Record<string, unknown>
	max_tokens?: number
	temperature?: number
}

/**
 * Build one `ToolDef` with `execution.type: 'prompt'`: `emw`-defined,
 * Alfred-executed (§7). The agent supplies only `arguments`; Alfred renders
 * the templates server-side and calls the alias sidecar model (never the
 * main agent model).
 */
export function toPromptTool(tool: PromptToolDef): ToolDef {
	const { alias, system_template, user_template, response_format, max_tokens, temperature } = tool
	if (!['text', 'extract', 'vision', 'jev'].includes(alias))
		throw new Error(`toPromptTool: unknown alias: ${alias}`)
	return {
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
		execution: {
			type: 'prompt',
			alias,
			system_template,
			user_template,
			...(response_format !== undefined ? { response_format } : {}),
			...(max_tokens !== undefined ? { max_tokens } : {}),
			...(temperature !== undefined ? { temperature } : {}),
		},
	}
}

export interface MixedToolsetOptions {
	/** Webhook-defined tools (host-owned, `execution.type: 'callback'`). */
	callbackTools?: AgentTool[]
	/**
	 * Hard-coded builtin descriptors to advertise
	 * (`execution.type: 'builtin'`). Pass the static mirror
	 * (`BUILTIN_GENERIC`/`BUILTIN_SPECIALISED` from `builtins.ts`) for
	 * offline selection, or descriptors from `AlfredClient.listTools()`
	 * (the live source of truth) when Alfred is reachable — or both (live
	 * entries whose `name` duplicates a static one are skipped).
	 */
	builtinDefs?: BuiltinToolDef[]
	/** `emw`-defined sidecars (`execution.type: 'prompt'`). */
	promptTools?: PromptToolDef[]
	policy?: ToolsetPolicy
	timeoutMs?: number
}

/**
 * Build a mixed session toolset: hard-coded builtins (Alfred executes
 * in-process, no keys) + webhook-defined callbacks (the host executes via
 * the generation's `webhook_url`) + `prompt` sidecars — so the caller
 * selects from one list instead of wiring three `execution` types by hand.
 *
 * Name collisions resolve in favour of the host: a `callback` tool shadows
 * a builtin of the same name (the host's Postgres-backed tool wins over the
 * generic primitive).
 */
export function toMixedToolset(opts: MixedToolsetOptions): ToolsetConfig {
	const callbackDefs = toToolset(
		opts.callbackTools ?? [],
		undefined,
		opts.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS
	).tools!
	const callbackNames = new Set(callbackDefs.map((t) => t.name))
	const seen = new Set<string>()
	const builtins = toBuiltinToolset(
		(opts.builtinDefs ?? []).filter((t) => {
			if (seen.has(t.name) || callbackNames.has(t.name)) return false
			seen.add(t.name)
			return true
		})
	)
	const prompts = (opts.promptTools ?? []).map(toPromptTool)
	return {
		tools: [...builtins, ...callbackDefs, ...prompts],
		policy: opts.policy,
	}
}

/**
 * Build the webhook handler Alfred POSTs tool calls to.
 *
 * Contract (see `butler/docs/alfred.md` §2.1 — synchronous):
 * - bad secret → `401`; malformed body → `400`.
 * - otherwise execute INLINE and return `{result} | {error}` in the POST
 *   response itself. No `202`, no `waitUntil`, no claim, no PUT-back.
 * - unknown tool and throwing tool both go back as `{ error }` (Alfred turns
 *   them into `is_error` tool results so the model can recover) — never a 5xx.
 */
export function createToolHandler(opts: ToolHandlerOptions): (req: Request) => Promise<Response> {
	const byName = new Map<string, AgentTool>(opts.tools.map((t) => [t.name, t]))
	const timeoutMs = opts.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS

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

		const { session_id, generation_id, tool_call_id, name } = body ?? {}
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
		const gid = typeof generation_id === 'string' ? generation_id : ''

		const tool = byName.get(name)
		if (!tool) {
			return json({ error: `unknown tool: ${name}` }, 200)
		}
		const ac = new AbortController()
		const timer = setTimeout(() => ac.abort(), timeoutMs)
		try {
			const scope = opts.resolveScope ? await opts.resolveScope(session_id) : {}
			const result = await tool.execute(body.arguments ?? {}, {
				sessionId: session_id,
				generationId: gid,
				toolCallId: tool_call_id,
				name,
				signal: ac.signal,
				scope,
			})
			return json({ result }, 200)
		} catch (err) {
			return json({ error: message(err) }, 200)
		} finally {
			clearTimeout(timer)
		}
	}
}
