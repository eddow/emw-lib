// emw-lib/src/lib/alfred/ask-human-cli-driver.ts
import { input, select } from '@inquirer/prompts'
import type { AskHumanDriver } from './ask-human-driver'
import type { HumanAnswer, HumanQuestion } from './types'

// TODO: is-interactive check
// TODO: graceful failure if @inquirer/prompts is not installed

export class CliAskHumanDriver implements AskHumanDriver {
	public async ask(questions: HumanQuestion[]): Promise<HumanAnswer[]> {
		const answers: HumanAnswer[] = []

		for (const q of questions) {
			let answer: HumanAnswer

			// Inquirer's `select` does not support an empty `choices` array.
			// If there are no options, fall back to free-text input if allowed.
			if (q.options?.length > 0) {
				const choices = q.options.map((o) => ({ name: o, value: o }))
				if (q.allow_free_text) {
					choices.push({ name: 'Write my own answer...', value: '__free_text__' })
				}

				const selectedOption = await select({
					message: q.text,
					choices: choices,
					default: choices[0].value,
				})

				if (selectedOption === '__free_text__') {
					const freeText = await input({ message: 'Please enter your answer:' })
					answer = { id: q.id, text: freeText, autopicked: false, timed_out: false }
				} else {
					answer = { id: q.id, choice: selectedOption, autopicked: false, timed_out: false }
				}
			} else if (q.allow_free_text) {
				const freeText = await input({ message: q.text })
				answer = { id: q.id, text: freeText, autopicked: false, timed_out: false }
			} else {
				throw new Error(
					`Question '${q.id}' is not answerable in a CLI environment: it has no options and does not allow free text.`
				)
			}
			answers.push(answer)
		}
		return answers
	}
}
