<script lang="ts">
	import Chat from './Chat.svelte'
	import type { StreamCredential } from './types.js'

	let {
		credential,
		onsend = null
	}: {
		credential?: StreamCredential
		onsend?: ((prompt: string) => Promise<StreamCredential | null>) | null
	} = $props()
</script>

<Chat
	credential={credential ?? {
		generation_id: 'gen_1',
		stream_token: 'test-token',
		stream_url: 'http://localhost:8192/streams/gen_1'
	}}
	{onsend}
/>

<p data-testid="host-generation-id">{credential?.generation_id ?? 'gen_1'}</p>
