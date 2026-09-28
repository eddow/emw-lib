/**
 * Server-only webhook wiring for Alfred's tool-callback contract
 * (`butler/alfred.md` §2.1).
 *
 * Client-safe `tools.ts` owns the portable core (`createToolHandler`); this
 * module owns the boring server glue every host repeats, so an `emw`-style
 * route shrinks to env + DB wiring:
 *
 * - {@link checkWebhookSecret} — the shared-secret check (Alfred is not a
 *   browser and has no cookie; empty secret = skip, mirroring Butler).
 * - {@link createWebhookHandler} — builds the `(req: Request) => Response`
 *   handler from tools + a pre-configured `AlfredClient` + host hooks.
 *
 * Server-only: import from a `+server.ts` via `emw-lib/alfred-server`,
 * never from browser code or the client-safe barrel.
 */

import { AlfredClient } from './client.js'
import { type AgentTool, createToolHandler } from './tools.js'

/**
 * Compare Alfred's shared secret against the request header. Returns `true`
 * when the call is authorized. An empty/missing `secret` skips the check
 * (local dev — same rule as Butler's `_check_webhook_secret`).
 */
export function checkWebhookSecret(req: Request, secret: string | undefined): boolean {
	if (!secret) return true
	return req.headers.get('x-alfred-secret') === secret
}

export interface WebhookHandlerOptions {
	/** The tools this webhook serves (dispatch is by payload `name`). */
	tools: AgentTool[]
	/**
	 * Server-side Alfred client used to PUT results back. Build it with the
	 * shared secret (`new AlfredClient({ baseUrl, webhookSecret })`) so the
	 * PUT-back carries `X-Alfred-Secret`.
	 */
	client?: AlfredClient
	/** Base URL of the Butler (used when `client` is omitted). */
	baseUrl?: string
	/**
	 * Shared secret for both legs (`ALFRED_WEBHOOK_SECRET`): verifies the
	 * incoming Alfred POST and signs the outgoing PUT-back. Empty = skip
	 * (local dev).
	 */
	webhookSecret?: string
	/**
	 * `sessionId` → scope for the tool context. The host owns the lookup
	 * (its session↔chat binding); the lib never reads the DB.
	 */
	resolveScope?: (sessionId: string) => Promise<Record<string, unknown>>
	/**
	 * Atomically claim a `tool_call_id` (durable in production — delivery is
	 * at-least-once). Return `false` when already handled → `200` no-op.
	 */
	claim?: (toolCallId: string) => Promise<boolean>
	/** Run work after the `202` (Vercel's `waitUntil` in production). */
	waitUntil?: (work: Promise<unknown>) => void
	/** Per-tool timeout in ms (default 15s). */
	timeoutMs?: number
}

/**
 * Build the webhook handler Alfred POSTs tool calls to. Thin wrapper over
 * `createToolHandler` with the secret check pre-wired: the host passes env
 * + DB hooks, gets back a `(req: Request) => Promise<Response>`.
 */
export function createWebhookHandler(
	opts: WebhookHandlerOptions
): (req: Request) => Promise<Response> {
	const client =
		opts.client ?? new AlfredClient({ baseUrl: opts.baseUrl, webhookSecret: opts.webhookSecret })
	return createToolHandler({
		tools: opts.tools,
		client,
		authorize: (req) => checkWebhookSecret(req, opts.webhookSecret),
		resolveScope: opts.resolveScope,
		claim: opts.claim,
		waitUntil: opts.waitUntil,
		timeoutMs: opts.timeoutMs,
	})
}
