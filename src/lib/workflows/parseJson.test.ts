/**
 * `wf.parseJson` ladder (checklist Phase 4.5).
 *
 * Pure + deterministic: every case re-runs identically on every tick.
 * `ParseError` is a normal `Error` — catchable for retry (a NEW
 * interaction, new idx), never a control-flow sentinel.
 */

import { describe, expect, it } from 'vitest'
import { extractBalanced, extractJsonValue, parseJson } from './parseJson.js'
import { InteractionFailed, isControlFlow, ParseError } from './types.js'

/** Minimal `SchemaLike`: accept anything (extraction-only tests). */
const anything = {
	safeParse: (data: unknown) => ({ success: true as const, data }),
}

/** Minimal `SchemaLike`: require `{ n: number }`. */
const needsN = {
	safeParse: (data: unknown) =>
		typeof data === 'object' && data !== null && typeof (data as { n?: unknown }).n === 'number'
			? { success: true as const, data: data as { n: number } }
			: { success: false as const, error: 'expected { n: number }' },
}

describe('parseJson ladder', () => {
	it('parses clean JSON', () => {
		expect.assertions(1)
		expect(parseJson('{"n":1}', needsN)).toEqual({ n: 1 })
	})

	it('strips markdown fences', () => {
		expect.assertions(2)
		expect(parseJson('```json\n{"n":2}\n```', needsN)).toEqual({ n: 2 })
		expect(parseJson('result:\n```\n{"n":3}\n```\ndone', needsN)).toEqual({ n: 3 })
	})

	it('extracts balanced JSON from prose', () => {
		expect.assertions(2)
		expect(parseJson('here you go {"n":4} hope it helps', needsN)).toEqual({ n: 4 })
		expect(parseJson('[{"n":5}]', anything)).toEqual([{ n: 5 }])
	})

	it('balanced extract is string/escape aware', () => {
		expect.assertions(2)
		expect(extractBalanced('{"a":"} not the end {","n":6} tail')).toBe(
			'{"a":"} not the end {","n":6}'
		)
		expect(extractBalanced('no json here')).toBeNull()
	})

	it('bad schema throws ParseError, not a run error', () => {
		expect.assertions(4)
		let caught: unknown
		try {
			parseJson('{"n":"oops"}', needsN)
		} catch (e) {
			caught = e
		}
		expect(caught).toBeInstanceOf(ParseError)
		expect(caught).toBeInstanceOf(Error)
		expect(isControlFlow(caught)).toBe(false)
		expect((caught as ParseError).message).toContain('schema')
	})

	it('no JSON at all throws ParseError', () => {
		expect.assertions(2)
		expect(() => parseJson('just prose, no braces', anything)).toThrow(ParseError)
		expect(() => extractJsonValue('   ')).toThrow('no JSON value')
	})

	it('ParseError and InteractionFailed are catchable Errors, never sentinels', () => {
		expect.assertions(4)
		expect(new ParseError('x')).toBeInstanceOf(Error)
		expect(new InteractionFailed('y')).toBeInstanceOf(Error)
		expect(isControlFlow(new ParseError('x'))).toBe(false)
		expect(isControlFlow(new InteractionFailed('y'))).toBe(false)
	})
})
