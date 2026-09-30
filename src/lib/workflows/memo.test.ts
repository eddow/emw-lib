/**
 * `fnSourceHash` / `stableStringify` / `payloadHash` (checklist Phase 4.6).
 *
 * Deterministic across ticks: same source → same hash, key order never
 * affects payload identity.
 */

import { describe, expect, it } from 'vitest'
import { fnSourceHash, payloadHash, stableStringify } from './memo.js'

describe('fnSourceHash', () => {
	it('is stable for identical source, whitespace-insensitive', () => {
		expect.assertions(3)
		const a = () => 1
		// biome-ignore format: intentional whitespace difference
		const b = () => 1
		expect(fnSourceHash(a)).toBe(fnSourceHash(b))
		expect(fnSourceHash(() => 1)).toBe(fnSourceHash(() => 1))
		expect(fnSourceHash(() => 1)).not.toBe(fnSourceHash(() => 2))
	})
})

describe('stableStringify / payloadHash', () => {
	it('ignores key order', () => {
		expect.assertions(2)
		expect(stableStringify({ b: 1, a: 2 })).toBe(stableStringify({ a: 2, b: 1 }))
		expect(payloadHash({ b: 1, a: 2 })).toBe(payloadHash({ a: 2, b: 1 }))
	})

	it('differs on value change, drops undefined like JSON', () => {
		expect.assertions(2)
		expect(payloadHash({ a: 1 })).not.toBe(payloadHash({ a: 2 }))
		expect(stableStringify({ a: 1, b: undefined })).toBe(stableStringify({ a: 1 }))
	})
})
