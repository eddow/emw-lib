<script lang="ts">
	import { untrack } from 'svelte'
	import { AlfredClient, type WorkflowRunStreamCredential } from '$lib/alfred/index.js'
	import {
		type WorkflowInteractionLite,
		WorkflowPane,
		WorkflowRunStream,
		type WorkflowStreamEvent
	} from '$lib/workflows/index.js'

	/**
	 * Workflow-dynamic e2e host: `WorkflowPane` wired to the scripted
	 * mock routes (`/demo/workflow-dynamic/...`), same wire shape as the
	 * real host routes. No Butler, no OpenRouter — deterministic.
	 *
	 * S7 transport: one `WorkflowRunStream` attach on mount (and on `?run=`
	 * re-attach) over the mock `/wfstreams` SSE route. The mock advances
	 * rows on `start`/`answer`/`cancel`/`fail` reactions (server-side
	 * harness hooks the page never calls to drive — S5 reactivity); the
	 * page only watches. `window.__wf` exposes the harness the e2e drives:
	 * `runId/phase/advance/hold/fail`. The run id persists in `?run=`
	 * (same as the real hosts' `goto(?run=)`) so a reload re-attaches:
	 * the mount effect re-attaches from `after_seq=0` (journal replay,
	 * no duplicates) and the SSE loop continues.
	 */

	interface AskHumanPrompt {
		idx: number
		question: string
		options: string[]
		answer?: unknown
	}

	type Phase = 'starting' | 'running' | 'done' | 'error' | 'cancelled'

	let runId = $state<string | null>(null)
	let phase = $state<Phase>('starting')
	let events = $state<WorkflowStreamEvent[]>([])
	let interactions = $state<WorkflowInteractionLite[]>([])
	let askHuman = $state<AskHumanPrompt[]>([])
	let output = $state<unknown>(null)
	let runError = $state<string | null>(null)
	let loadError = $state<string | null>(null)
	// S7 reactivity (no self-subscribing loops): the stream instance lives
	// in a plain holder (never `$state`) — the sync effect below subscribes
	// to the stream's OWN `$state` (`s.events`/`s.status`). `streamEpoch`
	// is bumped on attach/dispose so the effect picks up turnover.
	let runStream: WorkflowRunStream | null = null
	let streamEpoch = $state(0)

	const openAskHuman = $derived(askHuman.filter((q) => q.answer === undefined))

	/** Stable key for one stream event (dedup across SSE replay + live). */
	function streamEventKey(e: WorkflowStreamEvent): string {
		switch (e.type) {
			case 'interaction_opened':
				return `opened:${e.idx}`
			case 'interaction_resolved':
				return `resolved:${e.idx}:${e.status}`
			case 'run_status':
				return `status:${e.status}`
			case 'human_question':
				return `hq:${JSON.stringify(e.question)}`
			case 'human_answer':
				return `ha:${JSON.stringify(e.answer)}`
			case 'version_stale':
				return `stale:${e.deployment_url}:${e.opened_at}`
			case 'log':
				return `log:${e.tick}:${e.seq}`
		}
	}

	/**
	 * Journal truth for the SSE pane: `GET .../status` carries the
	 * terminal payload + ask-human questions/options (neither crosses the
	 * run stream). Fetched on mount (seed) and on terminal `run_status`.
	 */
	async function fetchStatus(id: string): Promise<void> {
		const res = await fetch(`/demo/workflow-dynamic/${id}/status`)
		if (!res.ok) throw new Error(`status failed: ${res.status}`)
		const body = (await res.json()) as {
			status: Phase
			returnValue: unknown
			error: unknown
			interactions: WorkflowInteractionLite[]
			askHuman: AskHumanPrompt[]
		}
		interactions = body.interactions ?? []
		askHuman = body.askHuman ?? askHuman
		if (body.status === 'done' || body.status === 'error' || body.status === 'cancelled') {
			phase = body.status
			output = body.returnValue
			runError = typeof body.error === 'string' && body.error.trim() !== '' ? body.error : null
		} else {
			phase = 'running'
		}
	}

	/** Fold SSE events into render state (dedup by `streamEventKey`). */
	function ingestStreamEvents(fresh: WorkflowStreamEvent[]): void {
		if (fresh.length === 0) return
		const seen = new Set(events.map((e) => streamEventKey(e)))
		const next: WorkflowStreamEvent[] = []
		for (const e of fresh) {
			const key = streamEventKey(e)
			if (seen.has(key)) continue
			seen.add(key)
			next.push(e)
		}
		if (next.length === 0) return
		events = [...events, ...next]
		const byIdx = new Map<number, WorkflowInteractionLite>()
		for (const i of interactions) byIdx.set(i.idx, i)
		for (const e of next) {
			if (e.type === 'interaction_opened') {
				byIdx.set(e.idx, {
					idx: e.idx,
					kind: e.kind,
					tool: e.tool ?? null,
					label: e.label,
					label_text: e.label_text,
					status: 'open'
				})
				// Ask-human Q&A travels via the `status` route (same
				// exception as the real hosts: `input_json` never crosses
				// the stream) — refresh it when a new row opens.
				if (e.tool === 'ask-human' && runId) {
					void fetchStatus(runId).catch((er) => (loadError = String(er)))
				}
			} else if (e.type === 'interaction_resolved') {
				const row = byIdx.get(e.idx)
				if (row) row.status = e.status
			}
		}
		interactions = [...byIdx.values()].sort((a, b) => a.idx - b.idx)
	}

	/**
	 * Attach the run stream for one run id. Replays from `after_seq=0`
	 * (dedup absorbs the `initial` seed overlap), then live. Terminal
	 * `run_status` disposes the stream and pulls the terminal payload
	 * via `fetchStatus`.
	 */
	function attachRunStream(id: string, cred: WorkflowRunStreamCredential): void {
		runStream?.dispose()
		const client = new AlfredClient({ fetchFn: fetch })
		const s = new WorkflowRunStream({ client, reconnectDelayMs: () => 0 })
		runStream = s
		streamEpoch += 1
		void s.attach(cred).catch((e) => (loadError = String(e)))
	}

	/**
	 * Reactive sync: fold the stream's ingested events into render state.
	 * Reading `runStream.events`/`runStream.status` here subscribes, so
	 * every ingest re-runs the sync. No timer. Terminal `run_status`
	 * disposes the stream and pulls the terminal payload via `fetchStatus`.
	 * Consumed events are drained from the stream log (`events = []` on
	 * the pane side is the dedup set; the stream log is the queue), so a
	 * re-run of this effect never double-ingests.
	 */
	$effect(() => {
		void streamEpoch
		const s = untrack(() => runStream)
		if (!s) return
		const id = untrack(() => runId)
		if (!id) return
		void s.events.length
		void s.status
		void s.error
		if (s.events.length === 0) return
		// No drain: `ingestStreamEvents` dedups against the pane log, so
		// re-runs are no-ops and settle.
		ingestStreamEvents(s.events)
		if (s.status === 'done' || s.status === 'error' || s.status === 'cancelled') {
			phase = s.status
			s.dispose()
			if (runStream === s) runStream = null
			void fetchStatus(id).catch((e) => (loadError = String(e)))
		} else {
			phase = 'running'
		}
		if (s.error) loadError = s.error
	})

	function disposeRunStream(): void {
		runStream?.dispose()
		runStream = null
		streamEpoch += 1
	}

	async function onstart(_input: Record<string, unknown>): Promise<void> {
		const res = await fetch('/demo/workflow-dynamic/start', { method: 'POST' })
		if (!res.ok) throw new Error(`start failed: ${res.status}`)
		// Same wire shape as the real `start` route
		// (`{ runId, deploymentUrl, status, stream }`).
		const body = (await res.json()) as {
			runId: string
			deploymentUrl: string
			status: Phase
			stream: WorkflowRunStreamCredential
		}
		runId = body.runId
		phase = 'running'
		events = []
		interactions = []
		askHuman = []
		output = null
		runError = null
		loadError = null
		// Persist the run in the URL so a reload re-attaches (no navigation).
		window.history.replaceState(null, '', `?run=${encodeURIComponent(runId)}`)
		// Journal seed first (first paint), then the SSE replay continues
		// from `after_seq=0` (dedup absorbs the overlap).
		await fetchStatus(runId)
		attachRunStream(runId, body.stream)
	}

	// Reload re-attach (W5): `?run=` survives `page.reload()`; re-fetch the
	// journal seed, then re-attach SSE from `after_seq=0`. No tick kick —
	// the mock advances on reactions only, so the manual clock stays
	// deterministic.
	let attachedFor: string | null = null
	$effect(() => {
		if (attachedFor) return
		const id = untrack(() => new URLSearchParams(window.location.search).get('run')?.trim() ?? '')
		if (!id) return
		attachedFor = id
		runId = id
		phase = 'running'
		events = []
		interactions = []
		askHuman = []
		output = null
		runError = null
		loadError = null
		void fetchStatus(id)
			.then(() => {
				attachRunStream(id, {
					run_id: id,
					stream_token: 'e2e-token',
					stream_url: `/demo/workflow-dynamic/wfstreams/${id}`
				})
			})
			.catch(() => {
				// Unknown run (e.g. stale link): back to the input form.
				attachedFor = null
				runId = null
				phase = 'starting'
				window.history.replaceState(null, '', window.location.pathname)
			})
	})

	async function oncancel(): Promise<void> {
		if (!runId) return
		await fetch(`/demo/workflow-dynamic/${runId}/cancel`, { method: 'POST' })
		// The cancel publishes `run_status: cancelled` — the SSE replay
		// delivers it; no poll needed.
	}

	async function answerAskHuman(idx: number, value: unknown): Promise<void> {
		if (!runId) return
		const res = await fetch(`/demo/workflow-dynamic/${runId}/answer`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ idx, answer: value })
		})
		if (!res.ok) throw new Error(`answer failed: ${res.status}`)
		// The answer resolves + re-ticks server-side and publishes — the
		// SSE replay delivers the continuation; the Q&A receipt travels
		// via the `status` route (same exception as the real hosts).
		// Refresh it here (the `interaction_resolved` alone carries no Q&A).
		await fetchStatus(runId).catch((e) => (loadError = String(e)))
	}

	$effect(() => {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		;(window as any).__wf = {
			runId: () => runId,
			phase: () => phase,
			// S7: the mock advances on reactions (server-side harness
			// hooks), never on a browser tick. `advance()` = one scripted
			// step (resolves the oldest open row, opens the next); the SSE
			// replay delivers it. `tick()` stays as an alias so the e2e
			// clock reads the same.
			advance: async () => {
				if (!runId) throw new Error('no run')
				const res = await fetch(`/demo/workflow-dynamic/${runId}/tick`, { method: 'POST' })
				if (!res.ok) throw new Error(`advance failed: ${res.status}`)
			},
			tick: async () => {
				if (!runId) throw new Error('no run')
				const res = await fetch(`/demo/workflow-dynamic/${runId}/tick`, { method: 'POST' })
				if (!res.ok) throw new Error(`tick failed: ${res.status}`)
			},
			fail: async () => {
				if (!runId) throw new Error('no run')
				await fetch(`/demo/workflow-dynamic/${runId}/fail`, { method: 'POST' })
			},
			hold: async () => {
				if (!runId) throw new Error('no run')
				await fetch(`/demo/workflow-dynamic/${runId}/hold`, { method: 'POST' })
			}
		}
		return () => {
			disposeRunStream()
		}
	})
</script>

<div data-testid="e2e-run-id" data-run={runId ?? ''} hidden></div>
<div data-testid="e2e-phase" data-phase={phase} hidden></div>
{#if loadError}
	<p class="rounded-md border px-3 py-2 text-sm" role="alert">{loadError}</p>
{/if}

<WorkflowPane
	{phase}
	fields={[{ name: 'productDescription', type: 'textarea', required: true }]}
	{events}
	{interactions}
	{output}
	{onstart}
	{oncancel}
	paneLabels={phase === 'error' && runError ? { errorEmpty: runError } : {}}
>
	{#snippet askHuman()}
		{#each openAskHuman as q (q.idx)}
			<button
				type="button"
				data-testid="wf-answer-a"
				onclick={() => void answerAskHuman(q.idx, 'a')}
			>
				Answer {q.question} with a
			</button>
		{/each}
	{/snippet}
</WorkflowPane>
