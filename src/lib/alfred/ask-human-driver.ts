// emw-lib/src/lib/alfred/ask-human-driver.ts
import type { HumanAnswer, HumanQuestion } from './types'

export interface AskHumanDriver {
	ask(questions: HumanQuestion[]): Promise<HumanAnswer[]>
}
