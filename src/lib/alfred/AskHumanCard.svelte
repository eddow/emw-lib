<script lang="ts">
	import type { HumanAnswer, HumanQuestion } from './types.js'

	/**
	 * Multiple-choice card for the `ask_human` convention (butler §9).
	 *
	 * One card per tool call, one row per question: option buttons (the
	 * FIRST is the preferred default, marked as such) plus a free-text
	 * input where the question allows it. A single submit answers all
	 * questions at once (`onanswer(answers)`); the parent posts them via
	 * `AlfredClient.answerAskHuman`. After answering (or on history replay)
	 * the card renders the receipt, disabled, with an autopick/timeout badge
	 * when the provenance says so.
	 */
	let {
		questions,
		answered = null,
		autopicked = false,
		timed_out = false,
		onanswer = null,
		labels = {}
	}: {
		questions: HumanQuestion[]
		/** Pre-filled answers (receipt / history replay). Disables the card. */
		answered?: HumanAnswer[] | null
		autopicked?: boolean
		timed_out?: boolean
		/** Called once with the answers for all questions. */
		onanswer?: ((answers: HumanAnswer[]) => Promise<void> | void) | null
		/**
		 * Translated UI strings. Paraglide lives in the host — pass
		 * `m.*()` strings here; English defaults apply otherwise.
		 */
		labels?: Partial<{
			freeTextPlaceholder: string
			autopicked: string
			timedOut: string
			answer: string
			answering: string
		}>
	} = $props()

	const receiptById = $derived(new Map((answered ?? []).map((a) => [a.id, a] as const)))
	const disabled = $derived(answered !== null && answered !== undefined)

	let picks = $state<Record<string, string>>({})
	let texts = $state<Record<string, string>>({})
	let sending = $state(false)
	let error = $state<string | null>(null)

	function pick(qid: string, option: string): void {
		if (disabled || sending) return
		picks[qid] = option
	}

	function answerFor(q: HumanQuestion): HumanAnswer | null {
		const receipt = receiptById.get(q.id)
		if (receipt) return receipt
		const text = (texts[q.id] ?? '').trim()
		if (text && q.allow_free_text) {
			return { id: q.id, text, autopicked: false, timed_out: false }
		}
		const choice = picks[q.id] ?? q.options[0]
		if (!choice) return null
		return { id: q.id, choice, autopicked: false, timed_out: false }
	}

	const ready = $derived(!disabled && questions.every((q) => answerFor(q) !== null))

	async function submit(): Promise<void> {
		if (!ready || !onanswer || sending) return
		const answers = questions.map((q) => answerFor(q)!)
		sending = true
		error = null
		try {
			await onanswer(answers)
		} catch (err) {
			error = err instanceof Error ? err.message : String(err)
		} finally {
			sending = false
		}
	}

	function label(q: HumanQuestion): string {
		const receipt = receiptById.get(q.id)
		if (!receipt) return ''
		return receipt.choice ?? receipt.text ?? ''
	}
</script>

<div class="alfred-human-card" data-testid="alfred-human-card">
	{#each questions as q, i (q.id)}
		<fieldset
			class="alfred-human-question"
			data-testid="alfred-human-question"
			disabled={disabled || sending}
		>
			<legend>{q.text}</legend>
			<div class="alfred-human-options" role="group" aria-label={q.text}>
				{#each q.options as option, oi (option)}
					{@const selected = disabled
						? label(q) === option
						: (picks[q.id] ?? q.options[0]) === option}
					<button
						type="button"
						data-testid="alfred-human-option"
						data-question={q.id}
						data-selected={selected}
						class:alfred-human-preferred={oi === 0}
						class:alfred-human-selected={selected}
						aria-pressed={selected}
						disabled={disabled || sending}
						onclick={() => pick(q.id, option)}
					>
						{option}{oi === 0 ? ' ★' : ''}
					</button>
				{/each}
			</div>
			{#if q.allow_free_text}
				<input
					type="text"
					data-testid="alfred-human-freetext"
					data-question={q.id}
					placeholder={labels.freeTextPlaceholder ?? 'Or type your own answer…'}
					bind:value={texts[q.id]}
					disabled={disabled || sending}
				/>
			{/if}
			{#if i === 0 && (autopicked || timed_out)}
				<p class="alfred-human-badge" data-testid="alfred-human-badge">
					{autopicked ? (labels.autopicked ?? 'auto-picked default') : (labels.timedOut ?? 'timed out')}
				</p>
			{/if}
		</fieldset>
	{/each}

	{#if !disabled}
		<button
			type="button"
			data-testid="alfred-human-submit"
			disabled={!ready || sending}
			onclick={() => void submit()}
		>
			{sending ? (labels.answering ?? 'Answering…') : (labels.answer ?? 'Answer')}
		</button>
	{/if}

	{#if error}
		<p class="alfred-human-error" data-testid="alfred-human-error" role="alert">{error}</p>
	{/if}
</div>

<style>
	.alfred-human-card {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		border: 1px solid currentColor;
		border-radius: 0.5rem;
		padding: 0.5rem;
	}
	.alfred-human-question {
		border: none;
		padding: 0;
		margin: 0;
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}
	.alfred-human-options {
		display: flex;
		flex-wrap: wrap;
		gap: 0.25rem;
	}
	.alfred-human-selected {
		font-weight: bold;
	}
	.alfred-human-badge {
		font-size: 0.8em;
		opacity: 0.75;
	}
	.alfred-human-error {
		color: red;
	}
</style>
