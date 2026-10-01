<script lang="ts">
	import { AlfredChat, type ChatSendMode, type StreamCredential } from '$lib/alfred/index.js'

	/**
	 * Dynamic-chat e2e host: `AlfredChat` wired to a controllable in-page
	 * mock chatbot. `window.__mock` exposes the harness the e2e drives:
	 * `emit(frame)` pushes one SSE frame into the open stream, `close()`
	 * ends it. Attach failures arm per-generation via `window.__e2eFailNext`
	 * (consumed in `nextCredentialAsync` below).
	 *
	 * `onsend` returns a same-origin credential pointing at the mock SSE
	 * endpoint (`/demo/chat-dynamic/streams/:gid`), so no Butler is needed.
	 */

	type Frame =
		| { kind: 'thought_delta' | 'answer_delta'; text: string }
		| { kind: 'thought' | 'answer'; text: string }
		| { kind: 'tool_use'; tool_call_id: string; name: string; args: unknown }
		| { kind: 'tool_result'; tool_call_id: string; name: string; output: unknown }
		| { kind: 'human_question'; tool_call_id: string }
		| { kind: 'human_answer'; tool_call_id: string }
		| { kind: 'done'; reason: string }
		| { kind: 'error'; error: string }

	let credential = $state<StreamCredential | null>(null)
	let gid = $state('gen_e2e_0')
	let sentModes = $state<string[]>([])
	let retried = $state<string[]>([])

	const sentModesJson = $derived(JSON.stringify(sentModes))
	const retriedJson = $derived(JSON.stringify(retried))

	async function nextCredentialAsync(): Promise<StreamCredential> {
		// E2E hook for the attach-failure test: the test plants
		// `window.__e2eFailNext` BEFORE clicking send; the arm lands HERE —
		// after the gid is minted but before the credential is returned
		// (the attach GET follows `onsend` resolving). Per-gid arming is
		// parallel-safe: only THIS generation's attach can consume it, so
		// no other test sharing the preview server can steal or be
		// poisoned by it — even with Playwright's repeat interleaving.
		// The arm POST is awaited BEFORE the credential is returned, so the
		// server has the arm before the attach GET can arrive. NOTE: this
		// relies on `vite preview` serving ONE SvelteKit server process —
		// `failByGid` is module-level state, so a multi-process preview
		// (clustered/round-robin) would lose the arm. If this test ever
		// flakes with "streaming · streaming" and no alert, check for a
		// second preview process first (`port 4173 already in use` in the
		// webServer log means the run reused a stale server).
		const fail = (window as unknown as { __e2eFailNext?: { status: number; detail: string } })
			.__e2eFailNext
		const res = await fetch('/demo/chat-dynamic/next-gid', { method: 'POST' })
		const body = (await res.json()) as { gid: string }
		gid = body.gid
		if (fail) {
			;(window as unknown as { __e2eFailNext?: unknown }).__e2eFailNext = undefined
			const arm = await fetch('/demo/chat-dynamic/control-fail', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ ...fail, gid })
			})
			if (!arm.ok) throw new Error(`arm failed: ${arm.status}`)
			// Read-your-write gate: the preview server must serve the arm
			// back before the attach GET runs. Without this, a stale
			// multi-process preview (or a restarted webServer that kept
			// the old port) can attach against a process that never saw
			// the arm — the stream opens clean and no alert renders.
			const gateRes = await fetch(`/demo/chat-dynamic/attached?gid=${gid}&armed=1`)
			const gate = (await gateRes.json()) as { armed?: boolean }
			if (!gate.armed) throw new Error(`arm lost for ${gid}`)
		}
		const next = {
			generation_id: gid,
			stream_token: 'e2e-token',
			stream_url: `/demo/chat-dynamic/streams/${gid}`
		}
		// Install immediately: `Chat.svelte` attaches from the RETURNED
		// credential, but installing here too covers hosts that remount on
		// `gid` change (no stale-credential window).
		credential = next
		return next
	}

	async function onsend(
		prompt: string,
		mode: ChatSendMode = 'prompt'
	): Promise<StreamCredential | null> {
		sentModes = [...sentModes, `${mode}:${prompt}`]
		if (mode === 'steer' || mode === 'interrupt' || mode === 'queue') {
			// Same generation, same stream: stay attached (mirrors emw's `{ok:true}` path).
			// Fire-and-forget: awaiting here would hold `sending=true` and
			// disable the composer for the rest of the live generation.
			void fetch(`/demo/chat-dynamic/control?gid=${gid}&op=${mode}`, { method: 'POST' })
			return null
		}
		const next = await nextCredentialAsync()
		// NOTE: no attach-gate here. `Chat.svelte:send()` attaches from the
		// returned credential AFTER `onsend` resolves; polling `/attached`
		// here would race the attach itself (false negatives). The mock
		// queues pre-attach frames and flushes on reader start — ordering
		// is by POST arrival, which `emit`'s awaited POST guarantees.
		return next
	}

	async function onstop(): Promise<void> {
		await fetch(`/demo/chat-dynamic/control?gid=${gid}&op=stop`, { method: 'POST' })
	}

	/** Retry continuation (S7): mint a fresh generation and attach it. */
	async function onretry(): Promise<StreamCredential> {
		retried = [...retried, gid]
		return nextCredentialAsync()
	}

	// The e2e drives the mock via these globals (see `chat-dynamic.e2e.ts`).
	// `gid()` is read lazily so frames always target the CURRENT generation.
	// `emit` awaits the POST AND the server's enqueue ack: two rapid emits
	// must be ordered server-side, otherwise deltas render out of order.
	$effect(() => {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		;(window as any).__mock = {
			emit: async (frame: Frame) => {
				const res = await fetch(`/demo/chat-dynamic/control?gid=${gid}`, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify(frame)
				})
				if (!res.ok) throw new Error(`emit failed: ${res.status}`)
				return res.json()
			},
			close: () => fetch(`/demo/chat-dynamic/control?gid=${gid}&op=close`, { method: 'POST' }),
			sentModes: () => sentModes,
			gid: () => gid
		}
	})
</script>

<div data-testid="e2e-sent-modes" data-modes={sentModesJson} hidden></div>
<div data-testid="e2e-gid" data-gid={gid} hidden></div>
<div data-testid="e2e-retried" data-retried={retriedJson} hidden></div>

<AlfredChat {credential} {onsend} {onstop} {onretry} />
