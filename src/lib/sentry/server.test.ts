import { describe, expect, it, vi } from 'vitest'
import {
	handleErrorWithSentry,
	initSentryClient,
	initSentryServer,
	sentryHandle,
	viteSentryPlugin,
	withSentryRoute,
} from './server.js'

describe('initSentryServer', () => {
	it('no-ops without a DSN', () => {
		expect.assertions(2)
		const init = vi.fn()
		expect(initSentryServer({ init, env: { dsn: '' } })).toBe(false)
		expect(init).not.toHaveBeenCalled()
	})
	it('inits with scrubbed defaults when configured', () => {
		expect.assertions(3)
		const init = vi.fn()
		const ok = initSentryServer(
			{
				init,
				env: { dsn: 'https://x@sentry.io/1', environment: 'production' },
			},
			{ mode: 'production' }
		)
		expect(ok).toBe(true)
		expect(init).toHaveBeenCalledOnce()
		const opts = init.mock.calls[0]?.[0] as Record<string, unknown>
		expect(opts).toMatchObject({ sendDefaultPii: false, tracesSampleRate: 0.1 })
	})
})

describe('initSentryClient', () => {
	it('no-ops on localhost dev runs', () => {
		expect.assertions(2)
		const init = vi.fn()
		const ok = initSentryClient(
			{ init, env: { dsn: 'https://x@sentry.io/1' } },
			{ hostname: 'localhost' }
		)
		expect(ok).toBe(false)
		expect(init).not.toHaveBeenCalled()
	})
})

describe('sentryHandle / handleErrorWithSentry', () => {
	it('delegates to the host SDK wrappers', () => {
		expect.assertions(2)
		const handle = { h: 1 }
		expect(sentryHandle({ sentryHandle: () => handle as never })).toBe(handle as never)
		const wrapped = { w: 1 }
		expect(handleErrorWithSentry({ handleErrorWithSentry: () => wrapped as never })).toBe(
			wrapped as never
		)
	})
})

describe('withSentryRoute', () => {
	it('passes the handler through', async () => {
		expect.assertions(1)
		const handler = async (x: number) => x * 2
		await expect(withSentryRoute(handler, { route: '/contact' })(21)).resolves.toBe(42)
	})
})

describe('viteSentryPlugin', () => {
	it('forwards org/project to the host plugin', async () => {
		expect.assertions(2)
		const plugins = [{ name: 'sentry' }]
		const sentrySvelteKit = vi.fn().mockResolvedValue(plugins as never)
		await expect(viteSentryPlugin({ org: 'o', project: 'p', sentrySvelteKit })).resolves.toBe(
			plugins as never
		)
		expect(sentrySvelteKit).toHaveBeenCalledWith({ org: 'o', project: 'p' })
	})
})
