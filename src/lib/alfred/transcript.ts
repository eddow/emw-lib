/**
 * Chat transcript — pure helpers turning Alfred history + live events into
 * renderable messages for {@link AlfredChat} (and `emw`'s future widget).
 *
 * Framework-free: no Svelte, no DOM. Tested in the `server` vitest project.
 * Deltas are never messages — the live draft is passed separately via
 * {@link buildTranscript}'s `streaming` arg and rendered as a pending bubble.
 */

import { isDeltaEvent } from './stream.js'
import type {
	DurableEvent,
	HistoryItem,
	HumanAnswer,
	HumanAnswerPayload,
	HumanQuestion,
	HumanQuestionPayload,
	LiveEvent,
} from './types.js'

/** One renderable chat bubble. */
export interface ChatMessage {
	id: string
	role: 'user' | 'assistant' | 'tool' | 'system' | 'human'
	text: string
	/** Durable `seq` when the message came from a durable event. */
	seq?: number
	/** Live streaming draft, not yet a durable event. */
	pending?: boolean
	/** Reasoning content — the UI hides it unless `showThought`. */
	thought?: boolean
	/**
	 * Render kind (plan `plans/ChatOutput.md` §1–2). Defaults to `'message'`
	 * when omitted (backwards compatible with pre-shape callers):
	 * - `tool_call`: paired `tool_use`→`tool_result` (or pending `tool_use`);
	 *   one-line summary in `text`, full args/output in `tool`.
	 * - `thought`: settled or live reasoning (also sets `thought: true`).
	 * - `status`: terminal `done/superseded|archived` one-liner, no retry.
	 * - `retry`: `done/max_iterations` or `error` — expandable box with a
	 *   Keep/Try-again button; `retryAfterS` triggers the 🐌 countdown.
	 */
	kind?: 'message' | 'tool_call' | 'thought' | 'status' | 'retry'
	/** Structured tool-call payload (`kind: 'tool_call'`). */
	tool?: {
		toolCallId: string
		toolName: string
		/** Raw arguments (stringified) for the `<details>` view. */
		argsText?: string
		/** Raw output/error for the `<details>` view. */
		outputText?: string
		/** False once the `tool_result` arrived (settled → collapsed). */
		pending: boolean
	}
	/** Terminal status reason (`kind: 'status'`). */
	status?: {
		reason: 'superseded' | 'archived'
	}
	/** Retryable terminal (`kind: 'retry'`). */
	retry?: {
		/** `max_iterations` for `done`, otherwise the error text. */
		reason: 'max_iterations' | 'error'
		/** Full error text for the `<details>` view. */
		errorText: string
		/** Parsed "wait N seconds then try again" hint (snail countdown). */
		retryAfterS?: number
	}
	/**
	 * Structured human-tool payload for the FE-registered renderer.
	 * Present on `role: 'human'` messages: the `human_question` carries the
	 * question (tool name + arguments/questions), the `human_answer` the
	 * receipt (answers/value + provenance). `answered` is true on receipts
	 * and on questions already resolved (history replay).
	 */
	human?: {
		toolCallId: string
		toolName: string
		questions?: HumanQuestion[]
		parameters?: Record<string, unknown>
		timeout_s?: number
		on_timeout?: 'autopick' | 'error'
		answers?: HumanAnswer[]
		value?: unknown
		autopicked?: boolean
		timed_out?: boolean
		answered: boolean
	}
}

/** Live draft rendered as pending bubble(s) by {@link buildTranscript}. */
export interface StreamingDraft {
	text?: string
	thought?: string
	showThought?: boolean
}

/** Best-effort stringify for tool payloads (arguments / outputs / errors). */
function stringify(value: unknown): string {
	if (typeof value === 'string') return value
	if (value === undefined || value === null) return ''
	try {
		return JSON.stringify(value)
	} catch {
		return String(value)
	}
}

/** Text of a `message` item's `content` (string, assistant/tool dicts, …). */
function contentText(content: unknown): string {
	if (typeof content === 'string') return content
	if (content && typeof content === 'object') {
		const c = content as Record<string, unknown>
		if (typeof c.content === 'string') return c.content
		return stringify(content)
	}
	return stringify(content)
}

/** Text of a durable event's `payload`. */
function payloadText(payload: unknown): string {
	if (typeof payload === 'string') return payload
	if (payload && typeof payload === 'object') {
		const p = payload as Record<string, unknown>
		if (typeof p.text === 'string') return p.text
		if ('output' in p) return stringify(p.output)
		if ('error' in p) return stringify(p.error)
		if ('reason' in p) return stringify(p.reason)
		return stringify(payload)
	}
	return stringify(payload)
}

/** First line of `s`, trimmed and truncated to `max` chars (for one-liners). */
function oneLine(s: string, max = 80): string {
	const line = s.split('\n').map((l) => l.trim()).find((l) => l !== '') ?? ''
	if (line.length <= max) return line
	return `${line.slice(0, max - 1).trimEnd()}…`
}

/** One-line summary for a tool call: `name — first line of args`. */
function toolSummary(name: string, argsText: string): string {
	const summary = oneLine(argsText)
	return summary ? `${name} — ${summary}` : name
}

/**
 * Parse an explicit "wait N seconds then try again" hint (rate-limit style)
 * from error text. Returns the wait in seconds, or `undefined` when the
 * payload carries no such hint (→ no blind auto-retry, plan §1.2).
 */
export function parseRetryAfterS(text: string): number | undefined {
	const m = /wait\s+(\d+)\s*(?:seconds?|secs?)\b/i.exec(text)
	if (!m) return undefined
	const n = Number.parseInt(m[1] ?? '', 10)
	return Number.isFinite(n) && n > 0 ? n : undefined
}

/** Map one durable event to a message; `null` when it renders nothing. */
export function eventMessage(
	type: string,
	payload: unknown,
	id: string,
	seq?: number
): ChatMessage | null {
	switch (type) {
		case 'answer': {
			const text = payloadText(payload)
			return text ? { id, role: 'assistant', text, seq } : null
		}
		case 'thought': {
			const text = payloadText(payload)
			return text ? { id, role: 'assistant', thought: true, text, seq, kind: 'thought' } : null
		}
		case 'tool_use': {
			const p = (payload ?? {}) as Record<string, unknown>
			const name = typeof p.name === 'string' ? p.name : 'tool'
			const toolCallId = typeof p.tool_call_id === 'string' ? p.tool_call_id : id
			const argsText = stringify(p.arguments)
			return {
				id,
				role: 'tool',
				text: toolSummary(name, argsText),
				seq,
				kind: 'tool_call',
				pending: true,
				tool: { toolCallId, toolName: name, argsText, pending: true },
			}
		}
		case 'tool_result': {
			const p = (payload ?? {}) as Record<string, unknown>
			const name = typeof p.name === 'string' ? p.name : 'tool'
			const toolCallId = typeof p.tool_call_id === 'string' ? p.tool_call_id : id
			const outputText = 'output' in p ? stringify(p.output) : stringify(p.error)
			if (!outputText) return null
			return {
				id,
				role: 'tool',
				text: toolSummary(name, outputText),
				seq,
				kind: 'tool_call',
				tool: { toolCallId, toolName: name, outputText, pending: false },
			}
		}
		case 'human_question': {
			const p = (payload ?? {}) as Partial<HumanQuestionPayload>
			const toolCallId = typeof p.tool_call_id === 'string' ? p.tool_call_id : id
			const toolName = typeof p.name === 'string' ? p.name : 'human'
			const questions = Array.isArray(p.questions) ? p.questions : undefined
			const args =
				p.arguments && typeof p.arguments === 'object'
					? (p.arguments as Record<string, unknown>)
					: undefined
			const text =
				questions?.map((q) => q.text).join('\n') ??
				(args ? stringify(args) : `${toolName}: awaiting human input`)
			return {
				id,
				role: 'human',
				text,
				seq,
				human: {
					toolCallId,
					toolName,
					questions,
					parameters:
						p.parameters && typeof p.parameters === 'object'
							? (p.parameters as Record<string, unknown>)
							: undefined,
					timeout_s: typeof p.timeout_s === 'number' ? p.timeout_s : undefined,
					on_timeout: p.on_timeout,
					answered: false,
				},
			}
		}
		case 'human_answer': {
			const p = (payload ?? {}) as Partial<HumanAnswerPayload>
			const toolCallId = typeof p.tool_call_id === 'string' ? p.tool_call_id : id
			const toolName = typeof p.tool_name === 'string' ? p.tool_name : 'human'
			const answers = Array.isArray(p.answers) ? p.answers : undefined
			const receipt =
				answers?.map((a) => a.choice ?? a.text ?? a.id).join(', ') ??
				(p.value !== undefined ? stringify(p.value) : 'answered')
			const flags = [
				p.autopicked ? '(autopicked)' : '',
				p.timed_out && !p.autopicked ? '(timed out)' : '',
			]
				.filter(Boolean)
				.join(' ')
			return {
				id,
				role: 'human',
				text: [`answered: ${receipt}`, flags].filter(Boolean).join(' ').trim(),
				seq,
				human: {
					toolCallId,
					toolName,
					answers,
					value: p.value,
					autopicked: p.autopicked,
					timed_out: p.timed_out,
					answered: true,
				},
			}
		}
		case 'done': {
			const reason = payloadText(payload) || 'stop'
			// `stop` renders nothing (plan §1.2).
			if (reason === 'stop') return null
			if (reason === 'superseded' || reason === 'archived') {
				return {
					id,
					role: 'system',
					text: reason,
					seq,
					kind: 'status',
					status: { reason },
				}
			}
			// `max_iterations` (and any unknown reason) → retry box.
			const text = `stopped early: ${reason}`
			return {
				id,
				role: 'system',
				text,
				seq,
				kind: 'retry',
				retry: { reason: 'max_iterations', errorText: text },
			}
		}
		case 'error': {
			const text = payloadText(payload) || 'error'
			const retryAfterS = parseRetryAfterS(text)
			return {
				id,
				role: 'system',
				text: oneLine(text),
				seq,
				kind: 'retry',
				retry: {
					reason: 'error',
					errorText: text,
					...(retryAfterS !== undefined ? { retryAfterS } : {}),
				},
			}
		}
		default:
			return { id, role: 'system', text: `[${type}] ${payloadText(payload)}`, seq }
	}
}

/**
 * Render durable history (`message` + `event` items, never deltas) as messages.
 * Message and event `seq` spaces are independent (`butler/alfred.md` §6), so
 * ids use the item index, not `seq`. `tool_use`→`tool_result` pairs (by
 * `tool_call_id`) are merged into a single `tool_call` message.
 *
 * Dedup rule: the `messages` table is the LLM replay log, the `events` table
 * is the display log — every assistant/tool write lands in BOTH (runner
 * writes the message row then the event row). Rendering both duplicates every
 * tool call (`tool` message ≈ `tool_result` output) and every final answer
 * (assistant message ≈ `answer` text). So:
 * - `tool` messages are skipped when a `tool_result` event with the same
 *   `tool_call_id` exists (orphans without an event still render as fallback).
 * - `assistant` messages are skipped when an `answer` event carries the same
 *   text (final answers). An assistant dict carrying `tool_calls` (turn
 *   preamble) renders only when its `content` is non-empty — otherwise it is
 *   just the empty shell around the `tool_use` one-liner.
 * - `user` messages always render (prompts live only in `messages`).
 */
export function historyToMessages(history: HistoryItem[]): ChatMessage[] {
	const answerTexts = new Set<string>()
	const resultCallIds = new Set<string>()
	for (const item of history) {
		if (item.kind !== 'event') continue
		const p = (item.payload ?? {}) as Record<string, unknown>
		if (item.type === 'answer' && typeof p.text === 'string' && p.text) {
			answerTexts.add(p.text)
		} else if (item.type === 'tool_result' && typeof p.tool_call_id === 'string') {
			resultCallIds.add(p.tool_call_id)
		}
	}
	const out: ChatMessage[] = []
	history.forEach((item, i) => {
		if (item.kind === 'message') {
			if (item.role === 'user') {
				const text = contentText(item.content)
				if (text) out.push({ id: `h-${i}`, role: 'user', text })
				return
			}
			if (item.role === 'tool') {
				const c =
					item.content && typeof item.content === 'object'
						? (item.content as Record<string, unknown>)
						: null
				const callId = c && typeof c.tool_call_id === 'string' ? c.tool_call_id : null
				// Covered by the paired `tool_result` one-liner — skip.
				if (callId && resultCallIds.has(callId)) return
				const text = contentText(item.content)
				if (text) out.push({ id: `h-${i}`, role: 'tool', text })
				return
			}
			if (item.role === 'assistant') {
				const c =
					item.content && typeof item.content === 'object'
						? (item.content as Record<string, unknown>)
						: null
				const hasToolCalls = c && Array.isArray(c.tool_calls) && c.tool_calls.length > 0
				const text = contentText(item.content)
				if (hasToolCalls) {
					// Turn preamble around the `tool_use` one-liner — keep only
					// when the model actually wrote something alongside the call.
					if (text.trim()) out.push({ id: `h-${i}`, role: 'assistant', text })
					return
				}
				// Final answer — covered by the `answer` event.
				if (text && answerTexts.has(text)) return
				if (text) out.push({ id: `h-${i}`, role: 'assistant', text })
				return
			}
			const text = contentText(item.content)
			if (text) out.push({ id: `h-${i}`, role: 'system', text })
		} else {
			const msg = eventMessage(item.type, item.payload, `h-${i}`, item.seq)
			if (msg) out.push(msg)
		}
	})
	return pairToolCalls(out)
}

/**
 * Stable JSON for dedup signatures (recursive key sort — history and SSE
 * replay serialize the same dict, but key order is not guaranteed).
 */
function stableJson(value: unknown): string {
	if (value === null || value === undefined) return ''
	if (typeof value !== 'object') return JSON.stringify(value) ?? ''
	if (Array.isArray(value)) return `[${value.map((v) => stableJson(v)).join(',')}]`
	const entries = Object.entries(value as Record<string, unknown>)
		.filter(([, v]) => v !== undefined)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
	return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`
}

/** Identity of one durable event for history-vs-live replay dedup. */
function eventSig(type: string, seq: number, payload: unknown): string {
	return `${type}|${seq}|${stableJson(payload)}`
}

/**
 * Drop live events already covered by history (multiset subtraction).
 *
 * The SSE replay starts at `after_seq=0`, so every durable event the SSR
 * `load` already fetched comes back a second time via the stream — the
 * same `tool_use`/`tool_result` pair and the same final `answer` render
 * twice. History items carry generation-local `seq`, and so do live events
 * of the same generation, so `(type, seq, payload)` identifies a replay.
 * Counts (not a set) preserve legitimate repeats: two identical answers
 * from two prompts still render twice.
 */
function dedupLiveEvents(history: HistoryItem[], events: LiveEvent[]): LiveEvent[] {
	const covered = new Map<string, number>()
	for (const item of history) {
		if (item.kind !== 'event') continue
		const key = eventSig(item.type, item.seq, item.payload)
		covered.set(key, (covered.get(key) ?? 0) + 1)
	}
	return events.filter((evt) => {
		if (isDeltaEvent(evt) || typeof evt.seq !== 'number') return true
		const key = eventSig(evt.type, evt.seq, (evt as DurableEvent).payload)
		const n = covered.get(key) ?? 0
		if (n <= 0) return true
		covered.set(key, n - 1)
		return false
	})
}

/**
 * Merge `tool_use` (pending, args only) with its later `tool_result` (output
 * only) by `tool_call_id` into one settled `tool_call` message. Keeps the
 * `tool_use` id; drops the standalone result. Idempotent — already-merged
 * messages (both texts, `pending: false`) pass through untouched.
 */
function pairToolCalls(messages: ChatMessage[]): ChatMessage[] {
	const pendingByCall = new Map<string, ChatMessage>()
	const out: ChatMessage[] = []
	for (const msg of messages) {
		if (msg.kind === 'tool_call' && msg.tool) {
			if (msg.tool.pending) {
				pendingByCall.set(msg.tool.toolCallId, msg)
				out.push(msg)
			} else if (!msg.tool.argsText) {
				const use = pendingByCall.get(msg.tool.toolCallId)
				if (use?.tool) {
					use.tool.outputText = msg.tool.outputText
					use.tool.pending = false
					use.pending = false
					use.text = toolSummary(
						use.tool.toolName,
						msg.tool.outputText ?? use.tool.argsText ?? ''
					)
					pendingByCall.delete(msg.tool.toolCallId)
					// Standalone result consumed — not pushed.
				} else {
					out.push(msg)
				}
			} else {
				out.push(msg)
			}
		} else {
			out.push(msg)
		}
	}
	return out
}

/**
 * Render live durable events as messages. Deltas are skipped — they are
 * ephemeral by design and surface through the `streaming` draft instead.
 * Ids use the array index: the same durable event can appear twice (once via
 * `loadHistory`, once via the SSE replay), and `seq` alone would collide.
 */
export function eventsToMessages(events: LiveEvent[]): ChatMessage[] {
	const out: ChatMessage[] = []
	events.forEach((evt, i) => {
		if (isDeltaEvent(evt)) return
		if (typeof evt.seq !== 'number') return
		const msg = eventMessage(evt.type, (evt as DurableEvent).payload, `e-${i}`, evt.seq)
		if (msg) out.push(msg)
	})
	return pairToolCalls(out)
}

/**
 * Full transcript: history, then live events, then the optional streaming
 * draft as pending bubble(s). Never mutates its inputs.
 */
export function buildTranscript(
	history: HistoryItem[],
	events: LiveEvent[],
	streaming?: StreamingDraft
): ChatMessage[] {
	// NOTE: historyToMessages/eventsToMessages already pair internally; do NOT
	// pair again here — a second pass would merge across the history/events
	// boundary and drop ids (double-pairing bug). Live events already covered
	// by history (SSE replay from after_seq=0) are dropped first, so the same
	// tool pair / answer never renders twice.
	const out = [...historyToMessages(history), ...eventsToMessages(dedupLiveEvents(history, events))]
	if (streaming?.showThought && streaming.thought) {
		out.push({
			id: 'streaming-thought',
			role: 'assistant',
			thought: true,
			text: streaming.thought,
			pending: true,
			kind: 'thought',
		})
	}
	if (streaming?.text) {
		out.push({ id: 'streaming-answer', role: 'assistant', text: streaming.text, pending: true })
	}
	return out
}
