<!--
 * Login screen (client-safe, unstyled hooks + minimal default CSS).
 *
 * Covers email/password sign-in, registration, lost-password
 * (request + confirm via `?token=`), and "Log in with…" social buttons.
 * The host app mounts it at its login route and passes an `AuthClient`
 * facade — the component never imports better-auth directly, so hosts can
 * swap the client without touching the UI.
 *
 * ```svelte
 * <LoginScreen client={authClientFacade} providers={socialProviders} ondone={goto('/')} />
 * ```
 -->

<script lang="ts">
	import { credentialFlows, listSocialProviders, type AuthProvider } from './types.js'

	/** Host-provided facade over `better-auth/svelte` (structural, swappable). */
	export interface AuthClient {
		signInEmail(input: {
			email: string
			password: string
		}): Promise<{ error: { message?: string } | null }>
		signUpEmail(input: {
			name: string
			email: string
			password: string
		}): Promise<{ error: { message?: string } | null }>
		requestPasswordReset(input: { email: string; redirectTo: string }): Promise<{
			error: { message?: string } | null
		}>
		resetPassword(input: { newPassword: string; token: string }): Promise<{
			error: { message?: string } | null
		}>
		signInSocial(input: { provider: string; callbackURL: string }): Promise<void>
	}

	let {
		client,
		allowlist = 'email',
		resetRedirectTo = '/login?reset=1',
		callbackURL = '/',
		ondone = null
	}: {
		/** Facade over the better-auth Svelte client. */
		client: AuthClient
		/** `AUTH_ENABLED_PROVIDERS` mirror (`PUBLIC_AUTH_ENABLED`). */
		allowlist?: string
		/** Where the reset-email link lands (must render this screen with `?token=`). */
		resetRedirectTo?: string
		/** Where to go after a successful sign-in/up. */
		callbackURL?: string
		/** Called after success when the host wants SPA navigation instead. */
		ondone?: ((path: string) => void) | null
	} = $props()

	type Mode = 'signin' | 'signup' | 'lost' | 'reset'
	let mode = $state<Mode>('signin')
	let name = $state('')
	let email = $state('')
	let password = $state('')
	let newPassword = $state('')
	let busy = $state(false)
	let error = $state<string | null>(null)
	let notice = $state<string | null>(null)

	const providers = $derived<AuthProvider[]>(listSocialProviders(allowlist))
	const flows = $derived(credentialFlows(allowlist))

	// `?token=` (reset link) / `?reset=1` (landing) switch modes on mount.
	$effect(() => {
		const params = new URLSearchParams(window.location.search)
		if (params.get('token')) mode = 'reset'
		else if (params.get('reset')) mode = 'signin'
	})

	function done(path: string): void {
		if (ondone) ondone(path)
		else window.location.href = path
	}

	async function run(
		fn: () => Promise<{ error: { message?: string } | null }>,
		ok: () => void
	): Promise<void> {
		busy = true
		error = null
		notice = null
		try {
			const { error: err } = await fn()
			if (err) error = err.message ?? 'Something went wrong'
			else ok()
		} catch (err) {
			error = err instanceof Error ? err.message : 'Something went wrong'
		} finally {
			busy = false
		}
	}

	async function onSignIn(e: SubmitEvent): Promise<void> {
		e.preventDefault()
		await run(
			() => client.signInEmail({ email, password }),
			() => done(callbackURL)
		)
	}

	async function onSignUp(e: SubmitEvent): Promise<void> {
		e.preventDefault()
		await run(
			() => client.signUpEmail({ name, email, password }),
			() => done(callbackURL)
		)
	}

	async function onRequestReset(e: SubmitEvent): Promise<void> {
		e.preventDefault()
		await run(
			() => client.requestPasswordReset({ email, redirectTo: resetRedirectTo }),
			() => {
				notice = 'Check your inbox for the reset link.'
			}
		)
	}

	async function onReset(e: SubmitEvent): Promise<void> {
		e.preventDefault()
		const token = new URLSearchParams(window.location.search).get('token') ?? ''
		await run(
			() => client.resetPassword({ newPassword, token }),
			() => {
				notice = 'Password updated — sign in with your new password.'
				mode = 'signin'
			}
		)
	}

	async function onSocial(provider: string): Promise<void> {
		busy = true
		error = null
		try {
			await client.signInSocial({ provider, callbackURL })
		} catch (err) {
			error = err instanceof Error ? err.message : 'Something went wrong'
			busy = false
		}
	}
</script>

<section class="emw-login" aria-label="Log in">
	{#if mode === 'reset'}
		<h1>Choose a new password</h1>
		<form onsubmit={onReset}>
			<label
				>New password
				<input
					type="password"
					bind:value={newPassword}
					required
					minlength="8"
					autocomplete="new-password"
				/>
			</label>
			{#if error}<p role="alert">{error}</p>{/if}
			{#if notice}<p role="status">{notice}</p>{/if}
			<button type="submit" disabled={busy}>Update password</button>
		</form>
		<button type="button" onclick={() => (mode = 'signin')}>Back to sign in</button>
	{:else if mode === 'lost'}
		<h1>Reset your password</h1>
		<form onsubmit={onRequestReset}>
			<label
				>Email
				<input type="email" bind:value={email} required autocomplete="email" />
			</label>
			{#if error}<p role="alert">{error}</p>{/if}
			{#if notice}<p role="status">{notice}</p>{/if}
			<button type="submit" disabled={busy}>Send reset link</button>
		</form>
		<button type="button" onclick={() => (mode = 'signin')}>Back to sign in</button>
	{:else}
		<h1>{mode === 'signup' ? 'Create your account' : 'Welcome back'}</h1>
		{#if flows.emailPassword}
			<form onsubmit={mode === 'signup' ? onSignUp : onSignIn}>
				{#if mode === 'signup'}
					<label
						>Name
						<input type="text" bind:value={name} required autocomplete="name" />
					</label>
				{/if}
				<label
					>Email
					<input type="email" bind:value={email} required autocomplete="email" />
				</label>
				<label
					>Password
					<input
						type="password"
						bind:value={password}
						required
						minlength="8"
						autocomplete={mode === 'signup' ? 'new-password' : 'current-password'}
					/>
				</label>
				{#if error}<p role="alert">{error}</p>{/if}
				{#if notice}<p role="status">{notice}</p>{/if}
				<button type="submit" disabled={busy}>
					{mode === 'signup' ? 'Sign up' : 'Sign in'}
				</button>
			</form>
			{#if mode === 'signin'}
				<button type="button" onclick={() => (mode = 'lost')}>Forgot your password?</button>
				<button type="button" onclick={() => (mode = 'signup')}>No account yet? Sign up</button>
			{:else}
				<button type="button" onclick={() => (mode = 'signin')}>Already registered? Sign in</button>
			{/if}
		{/if}
		{#if providers.length > 0}
			{#if flows.emailPassword}<hr />{/if}
			<div role="group" aria-label="Log in with">
				{#each providers as provider (provider.id)}
					<button type="button" disabled={busy} onclick={() => onSocial(provider.id)}>
						Log in with {provider.label}
					</button>
				{/each}
			</div>
		{/if}
	{/if}
</section>

<style>
	.emw-login {
		display: grid;
		gap: 1rem;
		max-width: 24rem;
		margin-inline: auto;
	}
	.emw-login form {
		display: grid;
		gap: 0.75rem;
	}
	.emw-login label {
		display: grid;
		gap: 0.25rem;
	}
</style>
