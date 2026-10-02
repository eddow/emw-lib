import { describe, expect, it } from 'vitest'
import {
	buildSentryOptions,
	defaultTracesSampleRate,
	readSentryEnv,
	scrubEvent,
	shouldInitSentry,
} from './index.js'

describe('defaultTracesSampleRate', () => {
	it('samples fully outside production', () => {
		expect.assertions(3)
		expect(defaultTracesSampleRate('development')).toBe(1.0)
		expect(defaultTracesSampleRate('preview')).toBe(1.0)
		expect(defaultTracesSampleRate('production')).toBe(0.1)
	})
})

describe('readSentryEnv', () => {
	it('maps SENTRY_* names, falls back to VERCEL_* then dev defaults', () => {
		expect.assertions(2)
		expect(readSentryEnv({})).toEqual({
			dsn: '',
			environment: 'development',
			release: 'dev',
			tracesSampleRate: 1.0,
		})
		expect(
			readSentryEnv({
				SENTRY_DSN: 'https://x@sentry.io/1',
				SENTRY_ENVIRONMENT: 'production',
				SENTRY_RELEASE: 'abc123',
				SENTRY_TRACES_SAMPLE_RATE: '0.5',
			})
		).toEqual({
			dsn: 'https://x@sentry.io/1',
			environment: 'production',
			release: 'abc123',
			tracesSampleRate: 0.5,
		})
	})
	it('derives environment/release from Vercel vars', () => {
		expect.assertions(1)
		expect(
			readSentryEnv({ VERCEL_ENV: 'production', VERCEL_GIT_COMMIT_SHA: 'sha9' })
		).toMatchObject({ environment: 'production', release: 'sha9' })
	})
	it('accepts the PUBLIC_ browser DSN', () => {
		expect.assertions(1)
		expect(readSentryEnv({ PUBLIC_SENTRY_DSN: 'https://y@sentry.io/2' }).dsn).toBe(
			'https://y@sentry.io/2'
		)
	})
})

describe('shouldInitSentry', () => {
	it('is false without a DSN', () => {
		expect.assertions(3)
		expect(shouldInitSentry('')).toBe(false)
		expect(shouldInitSentry(undefined)).toBe(false)
		expect(shouldInitSentry('   ')).toBe(false)
	})
	it('is false under vitest/playwright', () => {
		expect.assertions(3)
		expect(shouldInitSentry('https://x@sentry.io/1', { mode: 'test' })).toBe(false)
		process.env.VITEST = '1'
		expect(shouldInitSentry('https://x@sentry.io/1')).toBe(false)
		delete process.env.VITEST
		process.env.PLAYWRIGHT_TEST = '1'
		expect(shouldInitSentry('https://x@sentry.io/1')).toBe(false)
		delete process.env.PLAYWRIGHT_TEST
	})
	it('is false on localhost dev runs', () => {
		expect.assertions(4)
		const dsn = 'https://x@sentry.io/1'
		expect(shouldInitSentry(dsn, { hostname: 'localhost', mode: 'development' })).toBe(false)
		expect(shouldInitSentry(dsn, { hostname: '127.0.0.1', mode: 'development' })).toBe(false)
		expect(shouldInitSentry(dsn, { url: 'http://localhost:5173/', mode: 'development' })).toBe(
			false
		)
		expect(shouldInitSentry(dsn, { hostname: 'emw.emedware.dev', mode: 'production' })).toBe(true)
	})
})

describe('buildSentryOptions', () => {
	it('applies privacy defaults and env sampling', () => {
		expect.assertions(4)
		const opts = buildSentryOptions({ dsn: 'https://x@sentry.io/1', environment: 'production' })
		expect(opts.sendDefaultPii).toBe(false)
		expect(opts.replaysSessionSampleRate).toBe(0)
		expect(opts.tracesSampleRate).toBe(0.1)
		expect(typeof opts.beforeSend).toBe('function')
	})
})

describe('scrubEvent', () => {
	it('redacts headers, cookies, salt query and body secrets', () => {
		expect.assertions(5)
		const event = scrubEvent({
			request: {
				headers: { cookie: 'emw_salt=abc', authorization: 'Bearer x', 'x-other': 'ok' },
				query_string: 'salt=abc&lang=fr',
				cookies: { emw_salt: 'abc' },
				data: {
					OPENROUTER_API_KEY: 'sk-x',
					ALFRED_WEBHOOK_SECRET: 's',
					prompt: 'a'.repeat(600),
					subject: 'hello',
				},
			},
		})
		expect(event.request?.headers?.cookie).toBe('[Redacted]')
		expect(event.request?.headers?.['x-other']).toBe('ok')
		expect(event.request?.query_string).toBe('salt=%5BRedacted%5D&lang=fr')
		expect(event.request?.cookies?.emw_salt).toBe('[Redacted]')
		const data = event.request?.data as Record<string, unknown>
		expect(data.OPENROUTER_API_KEY).toBe('[Redacted]')
	})
	it('truncates long payloads and scrubs extras/breadcrumbs', () => {
		expect.assertions(3)
		const event = scrubEvent({
			extra: { text: 'b'.repeat(600) },
			breadcrumbs: [{ data: { ALFRED_STREAM_SECRET: 's' } }],
		})
		expect(String((event.extra as Record<string, unknown>).text)).toMatch(/\[truncated\]$/)
		expect(event.breadcrumbs?.[0]?.data?.ALFRED_STREAM_SECRET).toBe('[Redacted]')
		expect(event.breadcrumbs?.[0]?.data).toBeDefined()
	})
})
