// emw-lib/src/lib/alfred/ask-human.ts

// is-interactive is a CJS module for now
import isInteractive from 'is-interactive'
import type { HumanAnswer, HumanQuestion } from './types'

// A simple check to determine if we're in a CLI-like environment.
const isCli = process.env.EMW_CLI === 'true' || isInteractive()

export async function askHuman(questions: HumanQuestion[]): Promise<HumanAnswer[]> {
	if (isCli) {
		// Dynamically import the CLI driver to avoid pulling in `@inquirer/prompts`
		// into browser bundles.
		try {
			const { CliAskHumanDriver } = await import('./ask-human-cli-driver')
			const driver = new CliAskHumanDriver()
			return driver.ask(questions)
		} catch (e) {
			if (e instanceof Error && 'code' in e && e.code === 'ERR_MODULE_NOT_FOUND') {
				console.error("Error: The '@inquirer/prompts' package is not installed.")
				console.error("Please add it as a dependency to your CLI application's package.json.")
				process.exit(1)
			}
			throw e
		}
	} else {
		// In a non-CLI environment, we can't programmatically ask.
		// We throw an error, which the workflow engine should catch. It signals
		// that the engine must wait for an external event (e.g., a user clicking
		// a button in the UI) which will provide the answer.
		throw new Error('ASK_HUMAN_UI_REQUIRED')
	}
}
