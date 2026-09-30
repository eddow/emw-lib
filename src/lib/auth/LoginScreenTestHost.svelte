<script lang="ts">
	import LoginScreen from './LoginScreen.svelte'
	import type { AuthClient } from './LoginScreen.svelte'

	let { client }: { client?: AuthClient } = $props()

	const stub: AuthClient = {
		signInEmail: async () => ({ error: null }),
		signUpEmail: async () => ({ error: null }),
		requestPasswordReset: async () => ({ error: null }),
		resetPassword: async () => ({ error: null }),
		signInSocial: async () => {}
	}
</script>

<LoginScreen client={client ?? stub} allowlist="email,google,github" />
