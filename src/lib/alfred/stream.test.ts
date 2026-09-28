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
		expect(createStreamState()).toEqual({ text: '', thought: '', status: 'streaming', lastSeq: 0 })
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

	it('replaces the draft with the durable final answer', () => {
		let state = createStreamState()
		state = applyLiveEvent(state, delta('answer_delta', 'Hel'))
		state = applyLiveEvent(state, delta('answer_delta', 'lo'))
		state = applyLiveEvent(state, durable('answer', 3, { text: 'Hello world' }))
		expect(state.text).toBe('Hello world')
		expect(state.lastSeq).toBe(3)
	})

	it('replaces the thought draft with the durable final thought', () => {
		let state = createStreamState()
		state = applyLiveEvent(state, delta('thought_delta', 'partial'))
		state = applyLiveEvent(state, durable('thought', 2, { text: 'full reasoning' }))
		expect(state.thought).toBe('full reasoning')
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

	it('recovers the final draft after a reconnect replays a stale delta', () => {
		// Deltas never advance lastSeq, so the client reconnects from the durable
		// cursor and the replayed durable `answer` replaces any stale delta text.
		let state = createStreamState()
		state = applyLiveEvent(state, durable('answer', 3, { text: 'final' }))
		const replayed: LiveEvent[] = [
			delta('answer_delta', 'stale'),
			durable('answer', 3, { text: 'final' }),
		]
		for (const evt of replayed) state = applyLiveEvent(state, evt)
		expect(state.lastSeq).toBe(3)
		expect(state.text).toBe('final')
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
})
