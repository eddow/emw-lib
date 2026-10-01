<script lang="ts">
	import LoginScreen from './LoginScreen.svelte'
	import type { AuthClient } from './LoginScreen.svelte'
	import type { LoginLabels } from './types.js'

	let { client, labels = {} }: { client?: AuthClient; labels?: LoginLabels } = $props()

	const stub: AuthClient = {
		signInEmail: async () => ({ error: null }),
		signUpEmail: async () => ({ error: null }),
		requestPasswordReset: async () => ({ error: null }),
		resetPassword: async () => ({ error: null }),
		signInSocial: async () => {}
	}
</script>

<LoginScreen client={client ?? stub} allowlist="email,google,github" {labels} />
