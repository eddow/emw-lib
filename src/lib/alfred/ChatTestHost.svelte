<script lang="ts">
	import Chat from './Chat.svelte'
	import type { AlfredCredential } from './types.js'

	let {
		credential,
		sessionId = $bindable(null)
	}: { credential?: AlfredCredential; sessionId?: string | null } = $props()
</script>

<Chat
	credential={credential ?? { token: 'test-token', base_url: 'http://localhost:8192' }}
	agent={{ model: 'anthropic/claude-sonnet-4' }}
	bind:sessionId
/>

<p data-testid="host-session-id">{sessionId ?? '(none)'}</p>
