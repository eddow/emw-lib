<!--
 * Login screen (shadcn-shaped card, self-contained styles).
 *
 * The card reads the host's shadcn palette (`--card`, `--primary`, …)
 * when present (`emw`) and falls back to neutral defaults otherwise
 * (`arb2b`) — same `var(--token, fallback)` pattern as `AppMenu`.
 * Dark mode follows the host's `.dark` class (both `:root.dark` and
 * plain `.dark` selectors, matching the two host conventions).
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
	import { credentialFlows, listSocialProviders, type AuthProvider, type LoginLabels } from './types.js'

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

	const DEFAULT_LABELS = {
		login: 'Log in',
		chooseNewPassword: 'Choose a new password',
		enterNewPassword: 'Enter your new password below.',
		newPassword: 'New password',
		updatePassword: 'Update password',
		resetPassword: 'Reset your password',
		emailResetLink: "We'll email you a reset link.",
		sendResetLink: 'Send reset link',
		welcomeBack: 'Welcome back',
		signInContinue: 'Sign in to your account to continue.',
		createAccount: 'Create your account',
		createAccountIntro: 'Create your account to get started.',
		name: 'Name',
		email: 'Email',
		password: 'Password',
		confirmPassword: 'Repeat password',
		passwordMismatch: 'Passwords do not match',
		signUp: 'Sign up',
		signIn: 'Sign in',
		forgotPassword: 'Forgot your password?',
		noAccountSignUp: 'No account yet? Sign up',
		alreadyRegistered: 'Already registered? Sign in',
		backToSignIn: 'Back to sign in',
		orContinueWith: 'or continue with',
		loginWithGroup: 'Log in with',
		loginWith: (providerLabel: string) => `Log in with ${providerLabel}`,
		somethingWrong: 'Something went wrong',
		checkInbox: 'Check your inbox for the reset link.',
		passwordUpdated: 'Password updated — sign in with your new password.'
	} satisfies Required<LoginLabels>

	let {
		client,
		allowlist = 'email',
		resetRedirectTo = '/login?reset=1',
		callbackURL = '/',
		ondone = null,
		labels = {}
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
		/**
		 * Translated UI strings. Paraglide lives in the host — pass
		 * `m.*()` strings here; English defaults apply otherwise.
		 */
		labels?: LoginLabels
	} = $props()

	type Mode = 'signin' | 'signup' | 'lost' | 'reset'
	let mode = $state<Mode>('signin')
	let name = $state('')
	let email = $state('')
	let password = $state('')
	let confirmPassword = $state('')
	let newPassword = $state('')
	let newPasswordConfirm = $state('')
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
		const fallback = labels.somethingWrong ?? DEFAULT_LABELS.somethingWrong
		try {
			const { error: err } = await fn()
			if (err) error = err.message ?? fallback
			else ok()
		} catch (err) {
			error = err instanceof Error ? err.message : fallback
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
		if (password !== confirmPassword) {
			error = labels.passwordMismatch ?? DEFAULT_LABELS.passwordMismatch
			return
		}
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
				notice = labels.checkInbox ?? DEFAULT_LABELS.checkInbox
			}
		)
	}

	async function onReset(e: SubmitEvent): Promise<void> {
		e.preventDefault()
		if (newPassword !== newPasswordConfirm) {
			error = labels.passwordMismatch ?? DEFAULT_LABELS.passwordMismatch
			return
		}
		const token = new URLSearchParams(window.location.search).get('token') ?? ''
		await run(
			() => client.resetPassword({ newPassword, token }),
			() => {
				notice = labels.passwordUpdated ?? DEFAULT_LABELS.passwordUpdated
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
			error =
				err instanceof Error
					? err.message
					: (labels.somethingWrong ?? DEFAULT_LABELS.somethingWrong)
			busy = false
		}
	}
</script>

<section class="emw-login" aria-label={labels.login ?? DEFAULT_LABELS.login}>
	<div class="emw-login__card">
		{#if mode === 'reset'}
			<div class="emw-login__head">
				<h1>{labels.chooseNewPassword ?? DEFAULT_LABELS.chooseNewPassword}</h1>
				<p>{labels.enterNewPassword ?? DEFAULT_LABELS.enterNewPassword}</p>
			</div>
			<form class="emw-login__form" onsubmit={onReset}>
				<label class="emw-login__field"
					><span>{labels.newPassword ?? DEFAULT_LABELS.newPassword}</span>
					<input
						type="password"
						bind:value={newPassword}
						required
						minlength="8"
						autocomplete="new-password"
					/>
				</label>
				<label class="emw-login__field"
					><span>{labels.confirmPassword ?? DEFAULT_LABELS.confirmPassword}</span>
					<input
						type="password"
						bind:value={newPasswordConfirm}
						required
						minlength="8"
						autocomplete="new-password"
					/>
				</label>
				{#if error}<p class="emw-login__error" role="alert">{error}</p>{/if}
				{#if notice}<p class="emw-login__notice" role="status">{notice}</p>{/if}
				<button class="emw-login__btn emw-login__btn--primary" type="submit" disabled={busy}>
					{labels.updatePassword ?? DEFAULT_LABELS.updatePassword}
				</button>
			</form>
			<button type="button" class="emw-login__link" onclick={() => (mode = 'signin')}>
				{labels.backToSignIn ?? DEFAULT_LABELS.backToSignIn}
			</button>
		{:else if mode === 'lost'}
			<div class="emw-login__head">
				<h1>{labels.resetPassword ?? DEFAULT_LABELS.resetPassword}</h1>
				<p>{labels.emailResetLink ?? DEFAULT_LABELS.emailResetLink}</p>
			</div>
			<form class="emw-login__form" onsubmit={onRequestReset}>
				<label class="emw-login__field"
					><span>{labels.email ?? DEFAULT_LABELS.email}</span>
					<input type="email" bind:value={email} required autocomplete="email" />
				</label>
				{#if error}<p class="emw-login__error" role="alert">{error}</p>{/if}
				{#if notice}<p class="emw-login__notice" role="status">{notice}</p>{/if}
				<button class="emw-login__btn emw-login__btn--primary" type="submit" disabled={busy}>
					{labels.sendResetLink ?? DEFAULT_LABELS.sendResetLink}
				</button>
			</form>
			<button type="button" class="emw-login__link" onclick={() => (mode = 'signin')}>
				{labels.backToSignIn ?? DEFAULT_LABELS.backToSignIn}
			</button>
		{:else}
			<div class="emw-login__head">
				<h1>{mode === 'signup' ? (labels.createAccount ?? DEFAULT_LABELS.createAccount) : (labels.welcomeBack ?? DEFAULT_LABELS.welcomeBack)}</h1>
				<p>
					{mode === 'signup'
						? (labels.createAccountIntro ?? DEFAULT_LABELS.createAccountIntro)
						: (labels.signInContinue ?? DEFAULT_LABELS.signInContinue)}
				</p>
			</div>
			{#if flows.emailPassword}
				<form class="emw-login__form" onsubmit={mode === 'signup' ? onSignUp : onSignIn}>
					{#if mode === 'signup'}
						<label class="emw-login__field"
							><span>{labels.name ?? DEFAULT_LABELS.name}</span>
							<input type="text" bind:value={name} required autocomplete="name" />
						</label>
					{/if}
					<label class="emw-login__field"
						><span>{labels.email ?? DEFAULT_LABELS.email}</span>
						<input type="email" bind:value={email} required autocomplete="email" />
					</label>
					<label class="emw-login__field"
						><span>{labels.password ?? DEFAULT_LABELS.password}</span>
						<input
							type="password"
							bind:value={password}
							required
							minlength="8"
							autocomplete={mode === 'signup' ? 'new-password' : 'current-password'}
						/>
					</label>
					{#if mode === 'signup'}
						<label class="emw-login__field"
							><span>{labels.confirmPassword ?? DEFAULT_LABELS.confirmPassword}</span>
							<input
								type="password"
								bind:value={confirmPassword}
								required
								minlength="8"
								autocomplete="new-password"
							/>
						</label>
					{/if}
					{#if error}<p class="emw-login__error" role="alert">{error}</p>{/if}
					{#if notice}<p class="emw-login__notice" role="status">{notice}</p>{/if}
					<button class="emw-login__btn emw-login__btn--primary" type="submit" disabled={busy}>
						{mode === 'signup' ? (labels.signUp ?? DEFAULT_LABELS.signUp) : (labels.signIn ?? DEFAULT_LABELS.signIn)}
					</button>
				</form>
				<div class="emw-login__switch">
					{#if mode === 'signin'}
						<button type="button" class="emw-login__link" onclick={() => (mode = 'lost')}>
							{labels.forgotPassword ?? DEFAULT_LABELS.forgotPassword}
						</button>
						<button type="button" class="emw-login__link" onclick={() => (mode = 'signup')}>
							{labels.noAccountSignUp ?? DEFAULT_LABELS.noAccountSignUp}
						</button>
					{:else}
						<button type="button" class="emw-login__link" onclick={() => (mode = 'signin')}>
							{labels.alreadyRegistered ?? DEFAULT_LABELS.alreadyRegistered}
						</button>
					{/if}
				</div>
			{/if}
			{#if providers.length > 0}
				<div class="emw-login__divider" aria-hidden="true"><span>{labels.orContinueWith ?? DEFAULT_LABELS.orContinueWith}</span></div>
				<div class="emw-login__social" role="group" aria-label={labels.loginWithGroup ?? DEFAULT_LABELS.loginWithGroup}>
					{#each providers as provider (provider.id)}
						<button
							type="button"
							class="emw-login__btn emw-login__btn--outline"
							disabled={busy}
							onclick={() => onSocial(provider.id)}
						>
							{#if provider.id === 'google'}
								<svg class="emw-login__provider-icon" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
									<path fill="#4285F4" d="M23.5 12.27c0-.85-.08-1.66-.22-2.45H12v4.64h6.45a5.52 5.52 0 0 1-2.39 3.62v3h3.87c2.26-2.09 3.57-5.16 3.57-8.81z"/>
									<path fill="#34A853" d="M12 24c3.24 0 5.96-1.07 7.94-2.91l-3.87-3c-1.08.72-2.45 1.15-4.07 1.15-3.13 0-5.78-2.11-6.73-4.96H1.29v3.1A12 12 0 0 0 12 24z"/>
									<path fill="#FBBC05" d="M5.27 14.28A7.2 7.2 0 0 1 4.89 12c0-.79.14-1.56.38-2.28v-3.1H1.29a12 12 0 0 0 0 10.76l3.98-3.1z"/>
									<path fill="#EA4335" d="M12 4.77c1.76 0 3.34.61 4.58 1.8l3.44-3.44A11.97 11.97 0 0 0 12 0 12 12 0 0 0 1.29 6.62l3.98 3.1C6.22 6.88 8.87 4.77 12 4.77z"/>
								</svg>
							{:else if provider.id === 'microsoft'}
								<svg class="emw-login__provider-icon" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
									<rect x="1" y="1" width="10.5" height="10.5" fill="#F25022"/>
									<rect x="12.5" y="1" width="10.5" height="10.5" fill="#7FBA00"/>
									<rect x="1" y="12.5" width="10.5" height="10.5" fill="#00A4EF"/>
									<rect x="12.5" y="12.5" width="10.5" height="10.5" fill="#FFB900"/>
								</svg>
							{:else if provider.id === 'apple'}
								<svg class="emw-login__provider-icon" viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true" focusable="false">
									<path d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-2.429-1.025-5.704-.061-6.55.061zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701"/>
								</svg>
							{:else if provider.id === 'github'}
								<svg class="emw-login__provider-icon" viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true" focusable="false">
									<path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.55v-2.15c-3.2.7-3.87-1.36-3.87-1.36-.52-1.33-1.28-1.68-1.28-1.68-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.19 1.76 1.19 1.03 1.76 2.7 1.25 3.36.96.1-.75.4-1.25.72-1.54-2.55-.29-5.23-1.28-5.23-5.68 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11 11 0 0 1 5.8 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.83 1.19 3.09 0 4.41-2.69 5.38-5.25 5.67.41.35.77 1.05.77 2.12v3.14c0 .3.21.67.8.55A11.51 11.51 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5z"/>
								</svg>
							{:else if provider.id === 'gitlab'}
								<svg class="emw-login__provider-icon" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
									<path fill="#E24329" d="M12 21.9 7.7 8.6l-.1-.3c-.1-.2 0-.4.2-.5l.3-.1 3.9-1.2 3.9 1.2.3.1c.2.1.3.3.2.5l-.1.3L12 21.9z"/>
									<path fill="#FC6D26" d="M12 21.9 7.7 8.6H2.5l-.3.1c-.2.1-.3.3-.2.5l4.1 12.1c.1.3.4.5.7.5H12z"/>
									<path fill="#FCA326" d="M2.1 8.7c-.2-.2-.2-.5 0-.7l2.5-2.7c.1-.2.4-.2.6-.1l2.5 3.4H2.5z"/>
									<path fill="#FC6D26" d="M12 21.9h5.2c.3 0 .6-.2.7-.5l4.1-12.1c.1-.2 0-.4-.2-.5l-.3-.1H16.3L12 21.9z"/>
									<path fill="#FCA326" d="M21.9 8.7c.2-.2.2-.5 0-.7l-2.5-2.7c-.1-.2-.4-.2-.6-.1l-2.5 3.4h5.6z"/>
									<path fill="#E24329" d="M12 21.9 16.3 8.6H7.7L12 21.9z"/>
								</svg>
							{:else if provider.id === 'linkedin'}
								<svg class="emw-login__provider-icon" viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true" focusable="false">
									<path d="M20.45 20.45h-3.55v-5.57c0-1.33-.03-3.04-1.85-3.04-1.86 0-2.14 1.45-2.14 2.94v5.67H9.35V9h3.41v1.56h.05c.47-.9 1.63-1.85 3.36-1.85 3.6 0 4.27 2.37 4.27 5.46v6.28zM5.34 7.43a2.06 2.06 0 1 1 0-4.12 2.06 2.06 0 0 1 0 4.12zM7.12 20.45H3.56V9h3.56v11.45z"/>
								</svg>
							{/if}
							{labels.loginWith?.(provider.label) ?? DEFAULT_LABELS.loginWith(provider.label)}
						</button>
					{/each}
				</div>
			{/if}
		{/if}
	</div>
</section>

<style>
	/* shadcn-shaped card (self-contained: the lib ships no theme, so the
	 * tokens fall back to the host's shadcn palette — `emw` — or to these
	 * neutral defaults in hosts without one — `arb2b`). Same pattern as
	 * `AppMenu`'s `var(--menu-*, fallback)` vars. */
	.emw-login {
		--emw-login-bg: var(--card, oklch(1 0 0));
		--emw-login-fg: var(--card-foreground, oklch(0.145 0 0));
		--emw-login-muted: var(--muted-foreground, oklch(0.556 0 0));
		--emw-login-border: var(--border, oklch(0.922 0 0));
		--emw-login-input: var(--input, oklch(0.922 0 0));
		--emw-login-ring: var(--ring, oklch(0.708 0 0));
		--emw-login-primary: var(--primary, oklch(0.205 0 0));
		--emw-login-primary-fg: var(--primary-foreground, oklch(0.985 0 0));
		--emw-login-destructive: var(--destructive, oklch(0.577 0.245 27.325));
		--emw-login-radius: var(--radius, 0.625rem);
		display: grid;
		place-items: center;
		padding: 2rem 1rem;
	}
	.emw-login__card {
		display: grid;
		gap: 1.25rem;
		width: 100%;
		max-width: 24rem;
		padding: 1.5rem;
		border: 1px solid var(--emw-login-border);
		border-radius: var(--emw-login-radius);
		background: var(--emw-login-bg);
		color: var(--emw-login-fg);
		box-shadow:
			0 1px 2px rgb(0 0 0 / 0.06),
			0 8px 24px -12px rgb(0 0 0 / 0.18);
	}
	.emw-login__head {
		display: grid;
		gap: 0.375rem;
	}
	.emw-login__head h1 {
		font-size: 1.25rem;
		line-height: 1.4;
		font-weight: 600;
		letter-spacing: -0.01em;
		margin: 0;
	}
	.emw-login__head p {
		font-size: 0.875rem;
		color: var(--emw-login-muted);
		margin: 0;
	}
	.emw-login__form {
		display: grid;
		gap: 0.875rem;
	}
	.emw-login__field {
		display: grid;
		gap: 0.375rem;
		font-size: 0.875rem;
		font-weight: 500;
	}
	.emw-login__field input {
		height: 2.25rem;
		border: 1px solid var(--emw-login-input);
		border-radius: calc(var(--emw-login-radius) - 2px);
		background: transparent;
		padding: 0.5rem 0.75rem;
		font-size: 0.875rem;
		font-weight: 400;
		color: inherit;
		outline: none;
		transition:
			border-color 0.15s,
			box-shadow 0.15s;
	}
	.emw-login__field input:focus-visible {
		border-color: var(--emw-login-ring);
		box-shadow: 0 0 0 3px color-mix(in oklch, var(--emw-login-ring) 50%, transparent);
	}
	.emw-login__error {
		font-size: 0.875rem;
		color: var(--emw-login-destructive);
		margin: 0;
	}
	.emw-login__notice {
		font-size: 0.875rem;
		color: var(--emw-login-muted);
		margin: 0;
	}
	.emw-login__btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 0.5rem;
		height: 2.25rem;
		padding-inline: 1rem;
		border-radius: calc(var(--emw-login-radius) - 2px);
		border: 1px solid transparent;
		font-size: 0.875rem;
		font-weight: 500;
		cursor: pointer;
		transition:
			background 0.15s,
			opacity 0.15s;
	}
	.emw-login__provider-icon {
		flex: none;
	}
	.emw-login__btn:disabled {
		opacity: 0.5;
		pointer-events: none;
	}
	.emw-login__btn--primary {
		background: var(--emw-login-primary);
		color: var(--emw-login-primary-fg);
	}
	.emw-login__btn--primary:hover {
		opacity: 0.9;
	}
	.emw-login__btn--outline {
		border-color: var(--emw-login-input);
		background: transparent;
		color: inherit;
		box-shadow: 0 1px 2px rgb(0 0 0 / 0.05);
	}
	.emw-login__btn--outline:hover {
		background: color-mix(in oklch, var(--emw-login-fg) 5%, transparent);
	}
	.emw-login__switch {
		display: grid;
		gap: 0.25rem;
		justify-items: center;
	}
	.emw-login__link {
		background: none;
		border: none;
		padding: 0.25rem;
		font-size: 0.875rem;
		color: var(--emw-login-muted);
		text-decoration: underline;
		text-underline-offset: 4px;
		cursor: pointer;
	}
	.emw-login__link:hover {
		color: var(--emw-login-fg);
	}
	.emw-login__divider {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		font-size: 0.75rem;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--emw-login-muted);
	}
	.emw-login__divider::before,
	.emw-login__divider::after {
		content: '';
		flex: 1;
		height: 1px;
		background: var(--emw-login-border);
	}
	.emw-login__social {
		display: grid;
		gap: 0.5rem;
	}
	/* Host dark mode (`.dark` lives outside this component's scope, so the
	 * override must be global — same reason `layout.css` uses
	 * `@custom-variant dark`). `:root.dark` covers arb2b's `app.html`
	 * first-paint script; plain `.dark` covers emw. */
	:global(:root.dark) .emw-login,
	:global(.dark) .emw-login {
		--emw-login-bg: var(--card, oklch(0.205 0 0));
		--emw-login-fg: var(--card-foreground, oklch(0.985 0 0));
		--emw-login-muted: var(--muted-foreground, oklch(0.708 0 0));
		--emw-login-border: var(--border, oklch(1 0 0 / 10%));
		--emw-login-input: var(--input, oklch(1 0 0 / 15%));
		--emw-login-ring: var(--ring, oklch(0.556 0 0));
		--emw-login-primary: var(--primary, oklch(0.922 0 0));
		--emw-login-primary-fg: var(--primary-foreground, oklch(0.205 0 0));
	}
</style>
