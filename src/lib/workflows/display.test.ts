/**
 * `normalizeWorkflowOutput` + `groupParallelOpens`
 * (plan `plans/workflow-ui.md` §1: W-O normalisation, parallel grid).
 */

import { describe, expect, it } from 'vitest'
import { groupParallelOpens, normalizeWorkflowOutput } from './index.js'

describe('normalizeWorkflowOutput', () => {
	it('passes record W-O through entry-per-key', () => {
		expect.assertions(1)
		expect(normalizeWorkflowOutput({ verdicts: [], summary: 'Nothing to triage.' })).toEqual([
			{ key: 'verdicts', title: 'verdicts', value: [] },
			{ key: 'summary', title: 'summary', value: 'Nothing to triage.' },
		])
	})

	it('wraps string W-O as { result } with the Result default', () => {
		expect.assertions(1)
		expect(normalizeWorkflowOutput('findings summary')).toEqual([
			{ key: 'result', title: 'Result', value: 'findings summary' },
		])
	})

	it('resolves titles appLabels > defLabels > key', () => {
		expect.assertions(1)
		expect(
			normalizeWorkflowOutput(
				{ summary: 's', verdicts: [] },
				{
					defLabels: { summary: 'Summary', verdicts: 'Verdicts' },
					appLabels: { summary: 'Résumé' },
				}
			)
		).toEqual([
			{ key: 'summary', title: 'Résumé', value: 's' },
			{ key: 'verdicts', title: 'Verdicts', value: [] },
		])
	})
})

describe('groupParallelOpens', () => {
	it('groups consecutive idxs, splits on gaps', () => {
		expect.assertions(2)
		expect(groupParallelOpens([0, 1, 2, 5, 6, 9])).toEqual([[0, 1, 2], [5, 6], [9]])
		expect(groupParallelOpens([])).toEqual([])
	})
})
