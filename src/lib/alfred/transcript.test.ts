import { describe, expect, it } from 'vitest'
import {
	buildTranscript,
	eventsToMessages,
	historyToMessages,
	pairToolCalls,
	parseRetryAfterS,
} from './transcript.js'
import type { HistoryItem, LiveEvent } from './types.js'

describe('historyToMessages', () => {
	it('renders user messages and skips empty ones', () => {
		const history: HistoryItem[] = [
			{ kind: 'message', seq: 1, role: 'user', content: 'Hello' },
			{ kind: 'message', seq: 2, role: 'user', content: '' },
		]
		const out = historyToMessages(history)
		expect(out).toHaveLength(1)
		expect(out[0]).toMatchObject({ role: 'user', text: 'Hello' })
	})

	it('dedups tool messages covered by a tool_result event', () => {
		const history: HistoryItem[] = [
			{ kind: 'message', seq: 1, role: 'tool', content: { tool_call_id: 'c1', content: 'ok' } },
			{
				kind: 'event',
				seq: 1,
				type: 'tool_use',
				payload: { tool_call_id: 'c1', name: 'search', arguments: { q: 'x' } },
				ts: 't',
			},
			{
				kind: 'event',
				seq: 2,
				type: 'tool_result',
				payload: { tool_call_id: 'c1', name: 'search', output: 'ok' },
				ts: 't',
			},
		]
		const out = pairToolCalls(historyToMessages(history))
		expect(out).toHaveLength(1)
		expect(out[0]).toMatchObject({ kind: 'tool_call', pending: false })
	})

	it('pairs a history tool_use with a live tool_result (cross-boundary)', () => {
		const history: HistoryItem[] = [
			{
				kind: 'event',
				seq: 1,
				type: 'tool_use',
				payload: { tool_call_id: 'c1', name: 'search', arguments: { q: 'x' } },
				ts: 't',
			},
		]
		const events: LiveEvent[] = [
			{
				seq: 2,
				type: 'tool_result',
				payload: { tool_call_id: 'c1', name: 'search', output: 'found' },
				ts: 't',
			},
		]
		const out = buildTranscript(history, events)
		expect(out).toHaveLength(1)
		expect(out[0]).toMatchObject({ kind: 'tool_call', pending: false })
		expect(out[0].tool?.outputText).toContain('found')
	})

	it('keeps orphan tool messages with no matching tool_result event', () => {
		const history: HistoryItem[] = [
			{ kind: 'message', seq: 1, role: 'tool', content: { tool_call_id: 'c9', content: 'ok' } },
		]
		const out = historyToMessages(history)
		expect(out).toHaveLength(1)
		expect(out[0]).toMatchObject({ role: 'tool', text: 'ok' })
	})

	it('dedups final assistant messages covered by an answer event', () => {
		const history: HistoryItem[] = [
			{ kind: 'message', seq: 1, role: 'assistant', content: 'final' },
			{ kind: 'event', seq: 1, type: 'answer', payload: { text: 'final' }, ts: 't' },
		]
		const out = historyToMessages(history)
		expect(out).toHaveLength(1)
		expect(out[0]).toMatchObject({ role: 'assistant', text: 'final' })
	})

	it('drops empty assistant tool_calls shells, keeps non-empty preambles', () => {
		const history: HistoryItem[] = [
			{
				kind: 'message',
				seq: 1,
				role: 'assistant',
				content: { content: '', tool_calls: [{ id: 'c1' }] },
			},
			{
				kind: 'message',
				seq: 2,
				role: 'assistant',
				content: { content: 'let me look', tool_calls: [{ id: 'c2' }] },
			},
		]
		const out = historyToMessages(history)
		expect(out).toHaveLength(1)
		expect(out[0]).toMatchObject({ role: 'assistant', text: 'let me look' })
	})

	it('renders durable history without duplicating the live stream replay', () => {
		// Realistic history: every assistant/tool write lands in BOTH the
		// messages table (LLM replay) and the events table (display log).
		const history: HistoryItem[] = [
			{ kind: 'message', seq: 1, role: 'user', content: 'lookup x' },
			{
				kind: 'message',
				seq: 2,
				role: 'assistant',
				content: { content: '', tool_calls: [{ id: 'c1' }] },
			},
			{
				kind: 'event',
				seq: 1,
				type: 'tool_use',
				payload: { tool_call_id: 'c1', name: 'search', arguments: { q: 'x' } },
				ts: 't',
			},
			{ kind: 'message', seq: 3, role: 'tool', content: { tool_call_id: 'c1', content: 'found' } },
			{
				kind: 'event',
				seq: 2,
				type: 'tool_result',
				payload: { tool_call_id: 'c1', name: 'search', output: 'found' },
				ts: 't',
			},
			{ kind: 'message', seq: 4, role: 'assistant', content: 'done: found' },
			{ kind: 'event', seq: 3, type: 'answer', payload: { text: 'done: found' }, ts: 't' },
		]
		const out = pairToolCalls(historyToMessages(history))
		expect(out.map((m) => m.text)).toEqual(['lookup x', 'search — found', 'done: found'])
		expect(out.filter((m) => m.kind === 'tool_call')).toHaveLength(1)
	})

	it('renders event items (answer, tool_use, done/stop→null, error→retry)', () => {
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
		// `stop` renders nothing (plan §1.2).
		expect(out.map((m) => m.role)).toEqual(['assistant', 'tool', 'system'])
		expect(out[0].text).toBe('final')
		expect(out[1]).toMatchObject({ kind: 'tool_call', pending: true })
		expect(out[1].text).toContain('search')
		expect(out[1].tool).toMatchObject({ toolCallId: 'c1', toolName: 'search', pending: true })
		expect(out[2]).toMatchObject({ kind: 'retry' })
		expect(out[2].text).toContain('boom')
	})

	it('pairs tool_use→tool_result by tool_call_id into one settled message', () => {
		const history: HistoryItem[] = [
			{
				kind: 'event',
				seq: 1,
				type: 'tool_use',
				payload: { tool_call_id: 'c1', name: 'search', arguments: { q: 'x' } },
				ts: 't',
			},
			{
				kind: 'event',
				seq: 2,
				type: 'tool_result',
				payload: { tool_call_id: 'c1', name: 'search', output: 'found it' },
				ts: 't',
			},
		]
		// Pairing happens in `buildTranscript` (cross-boundary); `historyToMessages`
		// leaves the pair unpacked so a live `tool_result` can still join it.
		const out = buildTranscript(history, [])
		expect(out).toHaveLength(1)
		expect(out[0]).toMatchObject({ kind: 'tool_call', pending: false })
		expect(out[0].tool).toMatchObject({
			toolCallId: 'c1',
			toolName: 'search',
			pending: false,
		})
		expect(out[0].tool?.argsText).toContain('x')
		expect(out[0].tool?.outputText).toContain('found it')
	})

	it('keeps an unpaired tool_use pending (still running)', () => {
		const history: HistoryItem[] = [
			{
				kind: 'event',
				seq: 1,
				type: 'tool_use',
				payload: { tool_call_id: 'c1', name: 'search', arguments: { q: 'x' } },
				ts: 't',
			},
		]
		const out = historyToMessages(history)
		expect(out).toHaveLength(1)
		expect(out[0]).toMatchObject({ kind: 'tool_call', pending: true })
		expect(out[0].tool).toMatchObject({ pending: true })
	})

	it('maps done reasons: stop→null, superseded/archived→status, max_iterations→retry', () => {
		const reasons = ['stop', 'superseded', 'archived', 'max_iterations'] as const
		const history: HistoryItem[] = reasons.map((reason, i) => ({
			kind: 'event',
			seq: i + 1,
			type: 'done',
			payload: { reason },
			ts: 't',
		}))
		const out = historyToMessages(history)
		expect(out).toHaveLength(3)
		expect(out[0]).toMatchObject({ kind: 'status', status: { reason: 'superseded' } })
		expect(out[1]).toMatchObject({ kind: 'status', status: { reason: 'archived' } })
		expect(out[2]).toMatchObject({ kind: 'retry', retry: { reason: 'max_iterations' } })
	})

	it('parses an explicit wait-N-seconds hint, nothing otherwise', () => {
		expect(parseRetryAfterS('Rate limited: wait 60 seconds then try again')).toBe(60)
		expect(parseRetryAfterS('wait 5 secs and retry')).toBe(5)
		expect(parseRetryAfterS('boom')).toBeUndefined()
		expect(parseRetryAfterS('')).toBeUndefined()
	})

	it('maps error with a wait hint to retry with retryAfterS', () => {
		const history: HistoryItem[] = [
			{
				kind: 'event',
				seq: 1,
				type: 'error',
				payload: { error: 'Rate limited: wait 60 seconds then try again' },
				ts: 't',
			},
		]
		const out = historyToMessages(history)
		expect(out).toHaveLength(1)
		expect(out[0]).toMatchObject({ kind: 'retry', retry: { reason: 'error', retryAfterS: 60 } })
	})

	it('marks thought events with kind thought so the UI can hide them', () => {
		const history: HistoryItem[] = [
			{ kind: 'event', seq: 1, type: 'thought', payload: { text: 'hmm' }, ts: 't' },
		]
		const out = historyToMessages(history)
		expect(out).toHaveLength(1)
		expect(out[0]).toMatchObject({ role: 'assistant', thought: true, kind: 'thought', text: 'hmm' })
	})
})

describe('eventsToMessages', () => {
	it('skips deltas and renders durable events (done/stop→null)', () => {
		const events: LiveEvent[] = [
			{ type: 'answer_delta', stream_id: 's1', stream_seq: 1, text: 'Hel' },
			{ seq: 3, type: 'answer', payload: { text: 'Hello' }, ts: 't' },
			{ seq: 4, type: 'done', payload: { reason: 'stop' }, ts: 't' },
		]
		const out = eventsToMessages(events)
		expect(out).toHaveLength(1)
		expect(out[0]).toMatchObject({ role: 'assistant', text: 'Hello', seq: 3 })
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

	it('drops live events already covered by history (SSE replay from after_seq=0)', () => {
		const use = {
			kind: 'event',
			seq: 1,
			type: 'tool_use',
			payload: { tool_call_id: 'c1', name: 'search', arguments: { q: 'x' } },
			ts: 't',
		} as const
		const result = {
			kind: 'event',
			seq: 2,
			type: 'tool_result',
			payload: { tool_call_id: 'c1', name: 'search', output: 'found' },
			ts: 't',
		} as const
		const answer = {
			kind: 'event',
			seq: 3,
			type: 'answer',
			payload: { text: 'done' },
			ts: 't',
		} as const
		const history: HistoryItem[] = [
			{ kind: 'message', seq: 1, role: 'user', content: 'lookup x' },
			use,
			result,
			answer,
		]
		const events: LiveEvent[] = [
			{ seq: 1, type: 'tool_use', payload: { ...use.payload }, ts: 't' },
			{ seq: 2, type: 'tool_result', payload: { ...result.payload }, ts: 't' },
			{ seq: 3, type: 'answer', payload: { ...answer.payload }, ts: 't' },
		]
		const out = buildTranscript(history, events)
		expect(out.map((m) => m.text)).toEqual(['lookup x', 'search — found', 'done'])
		expect(out.filter((m) => m.kind === 'tool_call')).toHaveLength(1)
	})

	it('keeps live events that history does not cover (new work after load)', () => {
		const history: HistoryItem[] = [
			{ kind: 'message', seq: 1, role: 'user', content: 'lookup x' },
			{
				kind: 'event',
				seq: 1,
				type: 'answer',
				payload: { text: 'old answer' },
				ts: 't',
			},
		]
		const events: LiveEvent[] = [
			{ seq: 2, type: 'answer', payload: { text: 'new answer' }, ts: 't' },
		]
		const out = buildTranscript(history, events)
		expect(out.map((m) => m.text)).toEqual(['lookup x', 'old answer', 'new answer'])
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
