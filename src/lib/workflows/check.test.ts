/**
 * `checkWorkflow` static checks (checklist 9.2–9.3).
 */

import { describe, expect, it } from 'vitest'
import { checkWorkflow } from './check.js'

describe('checkWorkflow', () => {
	it('clean workflow passes both rules', () => {
		expect.assertions(2)
		const src = `
export async function triage({ createSession, all, use, once, log }, input) {
  if (input.urls.length === 0) {
    return { verdicts: [], summary: 'Nothing.' }
  } else {
    const v = once('k', () => 1)
    return { verdicts: [], summary: String(v) }
  }
}`
		const res = checkWorkflow(src)
		expect(res.ok).toBe(true)
		expect(res.findings).toEqual([])
	})

	it('missing return fails exhaustiveness (9.2)', () => {
		expect.assertions(2)
		const src = `
export async function broken({ use }, input) {
  await use.tool({ q: 1 })
}`
		const res = checkWorkflow(src)
		expect(res.ok).toBe(false)
		expect(res.findings.some((f) => f.rule === 'exhaustiveness')).toBe(true)
	})

	it('branch without else + no trailing return is flagged (9.2)', () => {
		expect.assertions(2)
		const src = `
export async function branchy({ use }, input) {
  if (input.x) {
    return 'a'
  }
  await use.tool({ q: 1 })
}`
		const res = checkWorkflow(src)
		expect(res.ok).toBe(false)
		expect(
			res.findings.some((f) => f.rule === 'exhaustiveness' && /branching/.test(f.message))
		).toBe(true)
	})

	it('Date/random/fetch outside once fail determinism (9.3)', () => {
		expect.assertions(4)
		const src = `
import { neon } from '@neondatabase/serverless'
export async function noisy({ use, once }, input) {
  const t = Date.now()
  const r = Math.random()
  await fetch('https://x')
  const db = neon('url')
  return String(t) + String(r)
}`
		const res = checkWorkflow(src)
		expect(res.ok).toBe(false)
		expect(res.findings.filter((f) => f.rule === 'determinism')).toHaveLength(4)
		expect(res.findings.some((f) => /Date/.test(f.message))).toBe(true)
		expect(res.findings.some((f) => /banned import/.test(f.message))).toBe(true)
	})

	it('clock inside once is allowed (9.3)', () => {
		expect.assertions(2)
		const src = `
export async function clocked({ once }, input) {
  const t = once('now', () => Date.now())
  return String(t)
}`
		const res = checkWorkflow(src)
		expect(res.ok).toBe(true)
		expect(res.findings).toEqual([])
	})

	it('node: imports are banned (9.3)', () => {
		expect.assertions(2)
		const src = `
import fs from 'node:fs'
export async function f({ once }, input) {
  return 'x'
}`
		const res = checkWorkflow(src)
		expect(res.ok).toBe(false)
		expect(res.findings.some((f) => /banned import/.test(f.message))).toBe(true)
	})
})
