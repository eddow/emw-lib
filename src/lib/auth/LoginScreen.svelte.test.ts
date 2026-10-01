import { describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-svelte'
import LoginScreenTestHost from './LoginScreenTestHost.svelte'

describe('LoginScreen', () => {
	it('renders sign-in form plus social buttons from the allowlist', async () => {
		const screen = await render(LoginScreenTestHost)
		await expect.element(screen.getByRole('heading', { name: 'Welcome back' })).toBeVisible()
		await expect.element(screen.getByLabelText(/email/i)).toBeVisible()
		await expect.element(screen.getByLabelText(/password/i)).toBeVisible()
		await expect.element(screen.getByRole('button', { name: 'Log in with Google' })).toBeVisible()
		await expect.element(screen.getByRole('button', { name: 'Log in with GitHub' })).toBeVisible()
		expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy()
	})
	it('switches to sign-up and lost-password modes', async () => {
		const screen = await render(LoginScreenTestHost)
		await screen.getByRole('button', { name: /no account yet/i }).click()
		await expect.element(screen.getByRole('heading', { name: 'Create your account' })).toBeVisible()
		await expect.element(screen.getByLabelText(/name/i)).toBeVisible()
		await screen.getByRole('button', { name: /already registered/i }).click()
		await screen.getByRole('button', { name: /forgot your password/i }).click()
		await expect.element(screen.getByRole('heading', { name: 'Reset your password' })).toBeVisible()
	})
	it('renders translated strings via the labels prop', async () => {
		const screen = await render(LoginScreenTestHost, {
			labels: {
				welcomeBack: 'Bon retour',
				signIn: 'Se connecter',
				loginWith: (l: string) => `Se connecter avec ${l}`,
			},
		})
		await expect.element(screen.getByRole('heading', { name: 'Bon retour' })).toBeVisible()
		await expect
			.element(screen.getByRole('button', { name: 'Se connecter avec Google' }))
			.toBeVisible()
	})
})
