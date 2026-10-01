/**
 * `defineAsyncWorkflow` registration.
 *
 * Mirrors the `marketAnalysis` workflow's shape — one async function over
 * `WFContext` + `describeStep` — and proves it registers in the map.
 */

import { describe, expect, it } from 'vitest'
import type { ToolRegistry, WFContext } from './index.js'
import {
	clearAsyncWorkflows,
	defineAsyncWorkflow,
	getAsyncWorkflow,
	listAsyncWorkflows,
} from './index.js'

type ExampleRegistry = ToolRegistry & {
	serp_search: { input: { source: string; terms: string }; output: { id: string }[] }
}

type WFInput = { productDescription: string; marketplaces: string[] }
type WFOutput = string

async function marketplaceAnalysis(
	{ createSession, all, use }: WFContext<ExampleRegistry>,
	input: WFInput
): Promise<WFOutput> {
	const session = await createSession({
		model: 'anthropic/claude-sonnet-4',
		systemPrompt: 'You are a marketplace research assistant.',
		initialPrompt: `Product under study: ${input.productDescription}`,
	})
	const terms = await session.prompt('terms', `Product: ${input.productDescription}`)
	const pages = await all(input.marketplaces.map((source) => use.serp_search({ source, terms })))
	return await session.prompt('summary', `Entries: ${pages.flat().length}`)
}

describe('defineAsyncWorkflow', () => {
	it('registers { name, version, fn, describeStep }', () => {
		expect.assertions(4)
		clearAsyncWorkflows()
		const def = defineAsyncWorkflow(marketplaceAnalysis, {
			name: 'marketplaceAnalysis',
			version: 1,
			describeStep: ({ label }) => `Step ${label}`,
		})
		expect(def.name).toBe('marketplaceAnalysis')
		expect(def.version).toBe(1)
		expect(getAsyncWorkflow('marketplaceAnalysis', 1)?.fn).toBe(marketplaceAnalysis)
		expect(listAsyncWorkflows()).toHaveLength(1)
		clearAsyncWorkflows()
	})

	it('get-missing returns undefined', () => {
		expect.assertions(2)
		clearAsyncWorkflows()
		expect(getAsyncWorkflow('nope', 1)).toBeUndefined()
		expect(listAsyncWorkflows()).toHaveLength(0)
	})

	it('duplicate name@version throws (no silent overwrite)', () => {
		expect.assertions(4)
		clearAsyncWorkflows()
		defineAsyncWorkflow(marketplaceAnalysis, {
			name: 'marketplaceAnalysis',
			version: 1,
			describeStep: ({ label }) => `Step ${label}`,
		})
		// Same reference re-evaluated (dev HMR): no-op, returns the def.
		const same = defineAsyncWorkflow(marketplaceAnalysis, {
			name: 'marketplaceAnalysis',
			version: 1,
			describeStep: ({ label }) => `Step ${label}`,
		})
		expect(same.fn).toBe(marketplaceAnalysis)
		expect(listAsyncWorkflows()).toHaveLength(1)
		// Genuinely different function under the same key still throws.
		async function otherAnalysis(
			_ctx: WFContext<ExampleRegistry>,
			_input: WFInput
		): Promise<WFOutput> {
			return 'other'
		}
		expect(() =>
			defineAsyncWorkflow(otherAnalysis, {
				name: 'marketplaceAnalysis',
				version: 1,
				describeStep: ({ label }) => `Step ${label}`,
			})
		).toThrow('already registered: marketplaceAnalysis@1')
		// Same name, different version is a distinct registration.
		defineAsyncWorkflow(marketplaceAnalysis, {
			name: 'marketplaceAnalysis',
			version: 2,
			describeStep: ({ label }) => `Step ${label}`,
		})
		expect(listAsyncWorkflows()).toHaveLength(2)
		clearAsyncWorkflows()
	})

	it('same source re-evaluation replaces the entry (dev HMR)', () => {
		expect.assertions(3)
		clearAsyncWorkflows()
		defineAsyncWorkflow(marketplaceAnalysis, {
			name: 'marketplaceAnalysis',
			version: 1,
			describeStep: ({ label }) => `Step ${label}`,
		})
		// Fresh closure, identical source (what HMR re-evaluation produces).
		// biome-ignore lint/security/noGlobalEval: test-only simulation of an HMR re-evaluation
		const again = eval(`(${marketplaceAnalysis.toString()})`) as typeof marketplaceAnalysis
		const def = defineAsyncWorkflow(again, {
			name: 'marketplaceAnalysis',
			version: 1,
			describeStep: ({ label }) => `Step ${label}`,
		})
		expect(def.fn).toBe(again)
		expect(getAsyncWorkflow('marketplaceAnalysis', 1)?.fn).toBe(again)
		expect(listAsyncWorkflows()).toHaveLength(1)
		clearAsyncWorkflows()
	})

	it('clearAsyncWorkflows isolates registrations', () => {
		expect.assertions(2)
		clearAsyncWorkflows()
		defineAsyncWorkflow(marketplaceAnalysis, {
			name: 'marketplaceAnalysis',
			version: 1,
			describeStep: ({ label }) => `Step ${label}`,
		})
		clearAsyncWorkflows()
		expect(getAsyncWorkflow('marketplaceAnalysis', 1)).toBeUndefined()
		expect(listAsyncWorkflows()).toHaveLength(0)
	})

	it('carries outputSchema for the tick W-O check (9.2)', () => {
		expect.assertions(3)
		clearAsyncWorkflows()
		const outputSchema = {
			safeParse(data: unknown) {
				return typeof data === 'string'
					? { success: true as const, data }
					: { success: false as const, error: 'want string' }
			},
		}
		const def = defineAsyncWorkflow(marketplaceAnalysis, {
			name: 'marketplaceAnalysis',
			version: 1,
			describeStep: ({ label }) => `Step ${label}`,
			outputSchema,
		})
		expect(def.outputSchema).toBe(outputSchema)
		expect(getAsyncWorkflow('marketplaceAnalysis', 1)?.outputSchema).toBe(outputSchema)
		// Absent without the meta key (unregistered-output workflows skip the check).
		clearAsyncWorkflows()
		const bare = defineAsyncWorkflow(marketplaceAnalysis, {
			name: 'marketplaceAnalysis',
			version: 1,
			describeStep: ({ label }) => `Step ${label}`,
		})
		expect(bare.outputSchema).toBeUndefined()
		clearAsyncWorkflows()
	})

	it('carries display meta for the FE catalogue (workflow-ui §1)', () => {
		expect.assertions(5)
		clearAsyncWorkflows()
		const def = defineAsyncWorkflow(marketplaceAnalysis, {
			name: 'marketplaceAnalysis',
			version: 1,
			describeStep: ({ label }) => `Step ${label}`,
			title: 'Market analysis',
			description: 'Research a product across marketplaces.',
			inputSpec: [
				{ name: 'productDescription', type: 'textarea', required: true },
				{ name: 'marketplaces', type: 'urls', required: true },
			],
			outputLabels: { result: 'Findings' },
		})
		expect(def.title).toBe('Market analysis')
		expect(def.description).toBe('Research a product across marketplaces.')
		expect(def.inputSpec).toHaveLength(2)
		expect(def.outputLabels).toEqual({ result: 'Findings' })
		expect(getAsyncWorkflow('marketplaceAnalysis', 1)?.title).toBe('Market analysis')
		clearAsyncWorkflows()
	})
})
