import { describe, expect, it } from 'vitest'
import { buildTranscript, eventsToMessages, historyToMessages } from './transcript.js'
import type { HistoryItem, LiveEvent } from './types.js'

describe('historyToMessages', () => {
	it('renders user/assistant/tool messages and skips empty ones', () => {
		const history: HistoryItem[] = [
			{ kind: 'message', seq: 1, role: 'user', content: 'Hello' },
			{ kind: 'message', seq: 2, role: 'assistant', content: 'Hi there' },
			{ kind: 'message', seq: 3, role: 'tool', content: { tool_call_id: 'c1', content: 'ok' } },
			{ kind: 'message', seq: 4, role: 'user', content: '' },
		]
		const out = historyToMessages(history)
		expect(out).toHaveLength(3)
		expect(out[0]).toMatchObject({ role: 'user', text: 'Hello' })
		expect(out[1]).toMatchObject({ role: 'assistant', text: 'Hi there' })
		expect(out[2]).toMatchObject({ role: 'tool', text: 'ok' })
	})

	it('renders event items (answer, tool_use, done, error)', () => {
		const history: HistoryItem[] = [
			{
				kind: 'event',
				seq: 1,
				type: 'answer',
				payload: { text: 'final' },
				ts: 't',
			},
			{
				kind: 'event',
				seq: 2,
				type: 'tool_use',
				payload: { tool_call_id: 'c1', name: 'search', arguments: { q: 'x' } },
				ts: 't',
			},
			{ kind: 'event', seq: 3, type: 'done', payload: { reason: 'stop' }, ts: 't' },
			{ kind: 'event', seq: 4, type: 'error', payload: { error: 'boom' }, ts: 't' },
		]
		const out = historyToMessages(history)
		expect(out.map((m) => m.role)).toEqual(['assistant', 'tool', 'system', 'system'])
		expect(out[0].text).toBe('final')
		expect(out[1].text).toContain('search')
		expect(out[2].text).toContain('stop')
		expect(out[3].text).toContain('boom')
	})

	it('marks thought events so the UI can hide them', () => {
		const history: HistoryItem[] = [
			{ kind: 'event', seq: 1, type: 'thought', payload: { text: 'hmm' }, ts: 't' },
		]
		const out = historyToMessages(history)
		expect(out).toHaveLength(1)
		expect(out[0]).toMatchObject({ role: 'assistant', thought: true, text: 'hmm' })
	})
})

describe('eventsToMessages', () => {
	it('skips deltas and renders durable events', () => {
		const events: LiveEvent[] = [
			{ type: 'answer_delta', stream_id: 's1', stream_seq: 1, text: 'Hel' },
			{ seq: 3, type: 'answer', payload: { text: 'Hello' }, ts: 't' },
			{ seq: 4, type: 'done', payload: { reason: 'stop' }, ts: 't' },
		]
		const out = eventsToMessages(events)
		expect(out).toHaveLength(2)
		expect(out[0]).toMatchObject({ role: 'assistant', text: 'Hello', seq: 3 })
		expect(out[1]).toMatchObject({ role: 'system', seq: 4 })
	})

	it('skips durable events without a seq', () => {
		const events: LiveEvent[] = [
			{ type: 'answer', payload: { text: 'x' }, ts: 't' } as unknown as LiveEvent,
		]
		expect(eventsToMessages(events)).toEqual([])
	})
})

describe('buildTranscript', () => {
	it('concatenates history + live events + the streaming draft', () => {
		const history: HistoryItem[] = [{ kind: 'message', seq: 1, role: 'user', content: 'Hello' }]
		const events: LiveEvent[] = [{ seq: 2, type: 'answer', payload: { text: 'Hi' }, ts: 't' }]
		const out = buildTranscript(history, events, { text: 'draft…' })
		expect(out.map((m) => m.text)).toEqual(['Hello', 'Hi', 'draft…'])
		expect(out[2]).toMatchObject({ pending: true, role: 'assistant' })
	})

	it('shows the thought draft only when showThought is set', () => {
		const hidden = buildTranscript([], [], { text: 'a', thought: 'hmm' })
		expect(hidden.some((m) => m.thought)).toBe(false)
		const shown = buildTranscript([], [], { text: 'a', thought: 'hmm', showThought: true })
		expect(shown).toHaveLength(2)
		expect(shown[0]).toMatchObject({ thought: true, pending: true, text: 'hmm' })
	})

	it('omits the draft when there is none', () => {
		expect(buildTranscript([], [])).toEqual([])
	})

	it('maps human_question to a human message with structured payload', () => {
		const events: LiveEvent[] = [
			{
				seq: 3,
				type: 'human_question',
				payload: {
					tool_call_id: 'call_1',
					name: 'ask_human',
					questions: [{ id: 'q', text: 'Pick?', options: ['a', 'b'] }],
					timeout_s: 0,
					on_timeout: 'autopick',
				},
				ts: 't',
			},
		]
		const out = eventsToMessages(events)
		expect(out).toHaveLength(1)
		expect(out[0]).toMatchObject({ role: 'human', text: 'Pick?', seq: 3 })
		expect(out[0].human).toMatchObject({
			toolCallId: 'call_1',
			toolName: 'ask_human',
			answered: false,
		})
		expect(out[0].human?.questions).toHaveLength(1)
	})

	it('maps generic human_question with arguments + parameters', () => {
		const events: LiveEvent[] = [
			{
				seq: 3,
				type: 'human_question',
				payload: {
					tool_call_id: 'call_g',
					name: 'pick_date',
					arguments: { label: 'When?' },
					parameters: { type: 'object', required: ['label'] },
					timeout_s: 0,
					on_timeout: 'autopick',
				},
				ts: 't',
			},
		]
		const out = eventsToMessages(events)
		expect(out[0].human).toMatchObject({ toolCallId: 'call_g', toolName: 'pick_date' })
		expect(out[0].human?.parameters).toMatchObject({ required: ['label'] })
	})

	it('maps human_answer to a receipt with provenance', () => {
		const events: LiveEvent[] = [
			{
				seq: 4,
				type: 'human_answer',
				payload: {
					tool_call_id: 'call_1',
					tool_name: 'ask_human',
					timed_out: true,
					autopicked: true,
					answers: [{ id: 'q', choice: 'a', autopicked: true, timed_out: true }],
				},
				ts: 't',
			},
		]
		const out = eventsToMessages(events)
		expect(out[0]).toMatchObject({ role: 'human', seq: 4 })
		expect(out[0].text).toContain('autopicked')
		expect(out[0].human).toMatchObject({ answered: true, autopicked: true })
	})
})
