<script lang="ts">
	import Chat from './Chat.svelte'
	import type { HistoryItem, StreamCredential } from './types.js'

	let {
		credential,
		history = [],
		onsend = null
	}: {
		credential?: StreamCredential | null
		history?: HistoryItem[]
		onsend?: ((prompt: string) => Promise<StreamCredential | null>) | null
	} = $props()
</script>

<Chat
	credential={credential === undefined
		? {
				generation_id: 'gen_1',
				stream_token: 'test-token',
				stream_url: 'http://localhost:8192/streams/gen_1'
			}
		: credential}
	{history}
	{onsend}
/>

<p data-testid="host-generation-id">{credential?.generation_id ?? 'gen_1'}</p>
