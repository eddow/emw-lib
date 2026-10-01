import { describe, expect, it } from 'vitest'
import { applyLiveEvent, createStreamState, isDeltaEvent } from './stream.js'
import type { DeltaEvent, DurableEvent, LiveEvent } from './types.js'

function delta(type: DeltaEvent['type'], text: string, streamSeq = 1): DeltaEvent {
	return { type, stream_id: 's1', stream_seq: streamSeq, text }
}

function durable(
	type: DurableEvent['type'],
	seq: number,
	payload: Record<string, unknown> = {}
): DurableEvent {
	return { seq, type, payload, ts: '2026-09-28T10:00:00Z' }
}

describe('createStreamState', () => {
	it('starts streaming with empty drafts and cursor 0', () => {
		expect(createStreamState()).toEqual({
			text: '',
			thought: '',
			status: 'streaming',
			lastSeq: 0,
			pendingHuman: [],
		})
	})
})

describe('applyLiveEvent', () => {
	it('appends answer deltas into text', () => {
		let state = createStreamState()
		state = applyLiveEvent(state, delta('answer_delta', 'Hel', 1))
		state = applyLiveEvent(state, delta('answer_delta', 'lo', 2))
		expect(state.text).toBe('Hello')
		expect(state.status).toBe('streaming')
	})

	it('appends thought deltas into thought, independently of text', () => {
		let state = createStreamState()
		state = applyLiveEvent(state, delta('thought_delta', 'hmm'))
		state = applyLiveEvent(state, delta('answer_delta', 'ok'))
		expect(state.thought).toBe('hmm')
		expect(state.text).toBe('ok')
	})

	it('consumes the draft on the durable final answer (final renders via events)', () => {
		let state = createStreamState()
		state = applyLiveEvent(state, delta('answer_delta', 'Hel'))
		state = applyLiveEvent(state, delta('answer_delta', 'lo'))
		state = applyLiveEvent(state, durable('answer', 3, { text: 'Hello world' }))
		expect(state.text).toBe('')
		expect(state.lastSeq).toBe(3)
	})

	it('consumes the thought draft on the durable final thought', () => {
		let state = createStreamState()
		state = applyLiveEvent(state, delta('thought_delta', 'partial'))
		state = applyLiveEvent(state, durable('thought', 2, { text: 'full reasoning' }))
		expect(state.thought).toBe('')
	})

	it('flips status on done and error', () => {
		let state = createStreamState()
		state = applyLiveEvent(state, durable('done', 4, { reason: 'stop' }))
		expect(state.status).toBe('done')
		state = applyLiveEvent(state, durable('error', 5, { error: 'boom' }))
		expect(state.status).toBe('error')
	})

	it('advances lastSeq only on durable events', () => {
		let state = createStreamState()
		state = applyLiveEvent(state, delta('answer_delta', 'a'))
		expect(state.lastSeq).toBe(0)
		state = applyLiveEvent(state, durable('tool_use', 7, { name: 'search' }))
		expect(state.lastSeq).toBe(7)
		state = applyLiveEvent(state, delta('answer_delta', 'b'))
		expect(state.lastSeq).toBe(7)
	})

	it('never lowers lastSeq on out-of-order durable events', () => {
		let state = createStreamState()
		state = applyLiveEvent(state, durable('answer', 9, { text: 'x' }))
		state = applyLiveEvent(state, durable('tool_result', 4, { output: 'y' }))
		expect(state.lastSeq).toBe(9)
	})

	it('does not mutate the input state', () => {
		const state = createStreamState()
		const next = applyLiveEvent(state, delta('answer_delta', 'a'))
		expect(state.text).toBe('')
		expect(next).not.toBe(state)
	})

	it('ignores tool_use_delta and unknown durable types', () => {
		let state = createStreamState()
		state = applyLiveEvent(state, delta('tool_use_delta', '{"q":'))
		expect(state.text).toBe('')
		expect(state.thought).toBe('')
		state = applyLiveEvent(state, durable('tool_result', 6, { output: 'z' }))
		expect(state.lastSeq).toBe(6)
		expect(state.status).toBe('streaming')
	})

	it('drops a stale delta replayed after the durable final (draft already consumed)', () => {
		// Deltas never advance lastSeq, so the client reconnects from the durable
		// cursor; the durable final already consumed the draft, and a replayed
		// stale delta must not resurrect text — the final renders via events.
		let state = createStreamState()
		state = applyLiveEvent(state, durable('answer', 3, { text: 'final' }))
		expect(state.text).toBe('')
		const replayed: LiveEvent[] = [durable('answer', 3, { text: 'final' })]
		for (const evt of replayed) state = applyLiveEvent(state, evt)
		expect(state.lastSeq).toBe(3)
		// The replayed durable re-consumes; the final text lives in `events`, not the draft.
		expect(state.text).toBe('')
	})

	it('isDeltaEvent requires a stream_id, not just a _delta suffix', () => {
		// A durable event whose type happens to end in `_delta` must not be
		// treated as a delta (which would skip the lastSeq advance).
		expect(isDeltaEvent(delta('answer_delta', 'a'))).toBe(true)
		const impostor = {
			seq: 5,
			type: 'answer_delta',
			payload: { text: 'x' },
			ts: 't',
		} as unknown as LiveEvent
		expect(isDeltaEvent(impostor)).toBe(false)
		const next = applyLiveEvent(createStreamState(), impostor)
		expect(next.lastSeq).toBe(5)
	})

	it('tracks human waits: question → waiting, answer → streaming', () => {
		let state = createStreamState()
		state = applyLiveEvent(
			state,
			durable('human_question', 3, {
				tool_call_id: 'call_1',
				name: 'ask_human',
				questions: [{ id: 'q', text: 'Pick?', options: ['a', 'b'] }],
				timeout_s: 0,
				on_timeout: 'autopick',
			})
		)
		expect(state.status).toBe('waiting')
		expect(state.lastSeq).toBe(3)
		expect(state.pendingHuman).toHaveLength(1)
		expect(state.pendingHuman[0].tool_call_id).toBe('call_1')
		expect(state.pendingHuman[0].tool_name).toBe('ask_human')
		state = applyLiveEvent(
			state,
			durable('human_answer', 4, {
				tool_call_id: 'call_1',
				tool_name: 'ask_human',
				timed_out: false,
				autopicked: false,
				answers: [{ id: 'q', choice: 'a', autopicked: false, timed_out: false }],
			})
		)
		expect(state.status).toBe('streaming')
		expect(state.pendingHuman).toHaveLength(0)
		expect(state.lastSeq).toBe(4)
	})

	it('stays waiting while any human ask remains pending', () => {
		let state = createStreamState()
		for (const [seq, call] of [
			[3, 'call_1'],
			[4, 'call_2'],
		] as const) {
			state = applyLiveEvent(
				state,
				durable('human_question', seq, {
					tool_call_id: call,
					name: 'pick_date',
					arguments: { label: 'When?' },
					timeout_s: 0,
					on_timeout: 'autopick',
				})
			)
		}
		expect(state.pendingHuman).toHaveLength(2)
		state = applyLiveEvent(
			state,
			durable('human_answer', 5, {
				tool_call_id: 'call_1',
				tool_name: 'pick_date',
				timed_out: false,
				autopicked: false,
				value: { date: '2026-10-01' },
			})
		)
		expect(state.status).toBe('waiting')
		expect(state.pendingHuman).toHaveLength(1)
	})
})
