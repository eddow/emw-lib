<script lang="ts">
	import Chat, { type ChatSendMode } from './Chat.svelte'
	import type { HistoryItem, StreamCredential } from './types.js'

	let {
		credential,
		history = [],
		onsend = null,
		onstop = null,
		onretry = null,
		...rest
	}: {
		credential?: StreamCredential | null
		history?: HistoryItem[]
		onsend?:
			| ((prompt: string, mode?: ChatSendMode) => Promise<StreamCredential | null>)
			| ((prompt: string) => Promise<StreamCredential | null>)
			| null
		onstop?: (() => Promise<void> | void) | null
		onretry?: ((msgId: string) => Promise<void> | void) | null
		// biome-ignore lint/suspicious/noExplicitAny: passthrough for label props in tests
		[key: string]: any
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
	{onstop}
	{onretry}
	{...rest}
/>

<p data-testid="host-generation-id">{credential?.generation_id ?? 'gen_1'}</p>
