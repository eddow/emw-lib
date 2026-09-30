/**
 * Alfred streaming reducer — headless, no DOM.
 *
 * Frontends (`emw`'s chat widget, scripts) feed {@link LiveEvent}s from
 * {@link AlfredClient.streamEvents} / {@link AlfredClient.pollLoop} into
 * {@link applyLiveEvent} and render the resulting {@link StreamState}.
 *
 * Rules (mirroring `butler/alfred.md` §4):
 * - `answer_delta` / `thought_delta` append to the current draft.
 * - durable `answer` / `thought` REPLACE the draft with `payload.text` (the
 *   final wins over accumulated deltas).
 * - `done` / `error` flip `status`.
 * - only durable events advance `lastSeq`; deltas never do (the reconnect
 *   cursor comes from durable `seq` alone — deltas are dropped on restart).
 */

import type {
	DeltaEvent,
	DurableEvent,
	HumanAnswerPayload,
	HumanPending,
	HumanQuestionPayload,
	LiveEvent,
} from './types.js'

export interface StreamState {
	/** Current answer draft (deltas applied, replaced by the final `answer`). */
	text: string
	/** Current reasoning draft (deltas applied, replaced by the final `thought`). */
	thought: string
	status: 'streaming' | 'waiting' | 'done' | 'error'
	/** Highest durable `seq` seen — the reconnect cursor. */
	lastSeq: number
	/** Pending human asks (keyed by `tool_call_id`), cleared on answer. */
	pendingHuman: HumanPending[]
}

/** Fresh state: streaming, empty drafts, cursor at 0. */
export function createStreamState(): StreamState {
	return { text: '', thought: '', status: 'streaming', lastSeq: 0, pendingHuman: [] }
}

/** Narrow a live event to a delta (deltas carry `stream_id`, durable events do not). */
export function isDeltaEvent(evt: LiveEvent): evt is DeltaEvent {
	return (
		typeof evt.type === 'string' &&
		evt.type.endsWith('_delta') &&
		'stream_id' in evt &&
		typeof (evt as DeltaEvent).stream_id === 'string'
	)
}

/** Read `payload.text` from a durable event, tolerating a missing payload. */
function payloadText(evt: DurableEvent): string {
	const text = evt.payload?.text
	return typeof text === 'string' ? text : ''
}

/**
 * Apply one live event, returning a NEW state (never mutates the input).
 * Unknown event types are passed through unchanged.
 *
 * `human_question` registers a pending ask (status → `waiting`);
 * `human_answer` clears it (status back to `streaming` unless other asks
 * remain pending). Only durable events advance `lastSeq`.
 */
export function applyLiveEvent(state: StreamState, evt: LiveEvent): StreamState {
	if (isDeltaEvent(evt)) {
		switch (evt.type) {
			case 'answer_delta':
				return { ...state, text: state.text + evt.text }
			case 'thought_delta':
				return { ...state, thought: state.thought + evt.text }
			default:
				// tool_use_delta carries no renderable draft in v1
				return state
		}
	}

	const durable = evt as DurableEvent
	const next: StreamState = { ...state, lastSeq: Math.max(state.lastSeq, durable.seq ?? 0) }
	switch (durable.type) {
		case 'answer':
			return { ...next, text: payloadText(durable) }
		case 'thought':
			return { ...next, thought: payloadText(durable) }
		case 'human_question': {
			const p = (durable.payload ?? {}) as Partial<HumanQuestionPayload>
			const toolCallId =
				typeof p.tool_call_id === 'string' ? p.tool_call_id : `q-${durable.seq ?? 0}`
			const pending: HumanPending = {
				generation_id: '',
				tool_call_id: toolCallId,
				session_id: '',
				tool_name: typeof p.name === 'string' ? p.name : '',
				payload: (p.arguments ?? {}) as Record<string, unknown>,
				questions: p.questions,
				deadline: 0,
				on_timeout: p.on_timeout ?? 'autopick',
				status: 'waiting',
				created_at: '',
			}
			if (p.questions) {
				pending.payload = { questions: p.questions }
			}
			const rest = next.pendingHuman.filter((w) => w.tool_call_id !== toolCallId)
			return { ...next, status: 'waiting', pendingHuman: [...rest, pending] }
		}
		case 'human_answer': {
			const p = (durable.payload ?? {}) as Partial<HumanAnswerPayload>
			const toolCallId = typeof p.tool_call_id === 'string' ? p.tool_call_id : ''
			const pendingHuman = toolCallId
				? next.pendingHuman.filter((w) => w.tool_call_id !== toolCallId)
				: next.pendingHuman
			return {
				...next,
				status: pendingHuman.length ? 'waiting' : 'streaming',
				pendingHuman,
			}
		}
		case 'done':
			return { ...next, status: 'done' }
		case 'error':
			return { ...next, status: 'error' }
		default:
			return next
	}
}
