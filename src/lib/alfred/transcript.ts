/**
 * Chat transcript — pure helpers turning Alfred history + live events into
 * renderable messages for {@link AlfredChat} (and `emw`'s future widget).
 *
 * Framework-free: no Svelte, no DOM. Tested in the `server` vitest project.
 * Deltas are never messages — the live draft is passed separately via
 * {@link buildTranscript}'s `streaming` arg and rendered as a pending bubble.
 */

import { isDeltaEvent } from './stream.js'
import type { DurableEvent, HistoryItem, LiveEvent } from './types.js'

/** One renderable chat bubble. */
export interface ChatMessage {
	id: string
	role: 'user' | 'assistant' | 'tool' | 'system'
	text: string
	/** Durable `seq` when the message came from a durable event. */
	seq?: number
	/** Live streaming draft, not yet a durable event. */
	pending?: boolean
	/** Reasoning content — the UI hides it unless `showThought`. */
	thought?: boolean
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

/** Map one durable event to a message; `null` when it renders nothing. */
function eventMessage(
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
			return text ? { id, role: 'assistant', thought: true, text, seq } : null
		}
		case 'tool_use': {
			const p = (payload ?? {}) as Record<string, unknown>
			const name = typeof p.name === 'string' ? p.name : 'tool'
			return { id, role: 'tool', text: `${name}: ${stringify(p.arguments)}`, seq }
		}
		case 'tool_result': {
			const p = (payload ?? {}) as Record<string, unknown>
			const text = 'output' in p ? stringify(p.output) : stringify(p.error)
			return text ? { id, role: 'tool', text, seq } : null
		}
		case 'done':
			return { id, role: 'system', text: `done: ${payloadText(payload) || 'stop'}`, seq }
		case 'error': {
			const text = payloadText(payload)
			return { id, role: 'system', text: text ? `error: ${text}` : 'error', seq }
		}
		default:
			return { id, role: 'system', text: `[${type}] ${payloadText(payload)}`, seq }
	}
}

/**
 * Render durable history (`message` + `event` items, never deltas) as messages.
 * Message and event `seq` spaces are independent (`butler/alfred.md` §6), so
 * ids use the item index, not `seq`.
 */
export function historyToMessages(history: HistoryItem[]): ChatMessage[] {
	const out: ChatMessage[] = []
	history.forEach((item, i) => {
		if (item.kind === 'message') {
			let role: ChatMessage['role'] = 'system'
			if (item.role === 'user') role = 'user'
			else if (item.role === 'assistant') role = 'assistant'
			else if (item.role === 'tool') role = 'tool'
			const text = contentText(item.content)
			if (text) out.push({ id: `h-${i}`, role, text })
		} else {
			const msg = eventMessage(item.type, item.payload, `h-${i}`, item.seq)
			if (msg) out.push(msg)
		}
	})
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
	return out
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
	const out = [...historyToMessages(history), ...eventsToMessages(events)]
	if (streaming?.showThought && streaming.thought) {
		out.push({
			id: 'streaming-thought',
			role: 'assistant',
			thought: true,
			text: streaming.thought,
			pending: true,
		})
	}
	if (streaming?.text) {
		out.push({ id: 'streaming-answer', role: 'assistant', text: streaming.text, pending: true })
	}
	return out
}
