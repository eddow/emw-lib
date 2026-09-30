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
	<div class="emw-login__card">
		{#if mode === 'reset'}
			<div class="emw-login__head">
				<h1>Choose a new password</h1>
				<p>Enter your new password below.</p>
			</div>
			<form class="emw-login__form" onsubmit={onReset}>
				<label class="emw-login__field"
					><span>New password</span>
					<input
						type="password"
						bind:value={newPassword}
						required
						minlength="8"
						autocomplete="new-password"
					/>
				</label>
				{#if error}<p class="emw-login__error" role="alert">{error}</p>{/if}
				{#if notice}<p class="emw-login__notice" role="status">{notice}</p>{/if}
				<button class="emw-login__btn emw-login__btn--primary" type="submit" disabled={busy}>
					Update password
				</button>
			</form>
			<button type="button" class="emw-login__link" onclick={() => (mode = 'signin')}>
				Back to sign in
			</button>
		{:else if mode === 'lost'}
			<div class="emw-login__head">
				<h1>Reset your password</h1>
				<p>We'll email you a reset link.</p>
			</div>
			<form class="emw-login__form" onsubmit={onRequestReset}>
				<label class="emw-login__field"
					><span>Email</span>
					<input type="email" bind:value={email} required autocomplete="email" />
				</label>
				{#if error}<p class="emw-login__error" role="alert">{error}</p>{/if}
				{#if notice}<p class="emw-login__notice" role="status">{notice}</p>{/if}
				<button class="emw-login__btn emw-login__btn--primary" type="submit" disabled={busy}>
					Send reset link
				</button>
			</form>
			<button type="button" class="emw-login__link" onclick={() => (mode = 'signin')}>
				Back to sign in
			</button>
		{:else}
			<div class="emw-login__head">
				<h1>{mode === 'signup' ? 'Create your account' : 'Welcome back'}</h1>
				<p>
					{mode === 'signup'
						? 'Create your account to get started.'
						: 'Sign in to your account to continue.'}
				</p>
			</div>
			{#if flows.emailPassword}
				<form class="emw-login__form" onsubmit={mode === 'signup' ? onSignUp : onSignIn}>
					{#if mode === 'signup'}
						<label class="emw-login__field"
							><span>Name</span>
							<input type="text" bind:value={name} required autocomplete="name" />
						</label>
					{/if}
					<label class="emw-login__field"
						><span>Email</span>
						<input type="email" bind:value={email} required autocomplete="email" />
					</label>
					<label class="emw-login__field"
						><span>Password</span>
						<input
							type="password"
							bind:value={password}
							required
							minlength="8"
							autocomplete={mode === 'signup' ? 'new-password' : 'current-password'}
						/>
					</label>
					{#if error}<p class="emw-login__error" role="alert">{error}</p>{/if}
					{#if notice}<p class="emw-login__notice" role="status">{notice}</p>{/if}
					<button class="emw-login__btn emw-login__btn--primary" type="submit" disabled={busy}>
						{mode === 'signup' ? 'Sign up' : 'Sign in'}
					</button>
				</form>
				<div class="emw-login__switch">
					{#if mode === 'signin'}
						<button type="button" class="emw-login__link" onclick={() => (mode = 'lost')}>
							Forgot your password?
						</button>
						<button type="button" class="emw-login__link" onclick={() => (mode = 'signup')}>
							No account yet? Sign up
						</button>
					{:else}
						<button type="button" class="emw-login__link" onclick={() => (mode = 'signin')}>
							Already registered? Sign in
						</button>
					{/if}
				</div>
			{/if}
			{#if providers.length > 0}
				<div class="emw-login__divider" aria-hidden="true"><span>or continue with</span></div>
				<div class="emw-login__social" role="group" aria-label="Log in with">
					{#each providers as provider (provider.id)}
						<button
							type="button"
							class="emw-login__btn emw-login__btn--outline"
							disabled={busy}
							onclick={() => onSocial(provider.id)}
						>
							Log in with {provider.label}
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
