/**
 * `theme.css` regression: the shared tokens + native form base must stay in
 * sync with the host contract (arb2b dark-mode white-input bug).
 *
 * - `:root` (light) and `:root.dark, .dark` (dark) define the full shadcn
 *   token set lib components read (`--background`, `--input`, `--card`,
 *   …) — a minimal host importing only this file gets dark-aware inputs.
 * - The native `input`/`textarea`/`select` base paints from those tokens
 *   (never the UA white), with `color-scheme` switching per theme.
 * - `arb2b`'s `layout.css` imports the shared file instead of redefining
 *   a `--menu-*`-only subset (the exact drift that caused the bug).
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const themeCss = readFileSync(join(here, 'theme.css'), 'utf8')

/** Monorepo root: `emw-lib` lives at `<root>/emw-lib` next to `arb2b`. */
const repoRoot = join(here, '..', '..', '..')

describe('theme.css', () => {
	it('defines light tokens on :root and dark tokens on :root.dark/.dark', () => {
		expect.assertions(8)
		expect(themeCss).toMatch(/:root\s*\{[^}]*--background:/s)
		expect(themeCss).toMatch(/:root\s*\{[^}]*color-scheme:\s*light/s)
		expect(themeCss).toMatch(/:root\.dark/)
		expect(themeCss).toMatch(/color-scheme:\s*dark/)
		// Dark block redefines the tokens lib components read.
		const darkBlock = themeCss.slice(themeCss.indexOf(':root.dark'))
		for (const token of ['--background:', '--foreground:', '--input:', '--card:'])
			expect(darkBlock).toContain(token)
	})
	it('gives native fields a theme-aware base (never UA white)', () => {
		expect.assertions(5)
		expect(themeCss).toMatch(/textarea/)
		expect(themeCss).toMatch(/background-color:\s*var\(--background\)/)
		expect(themeCss).toMatch(/color:\s*var\(--foreground\)/)
		// Bare `<button>` renders a themed button, never the UA grey.
		expect(themeCss).toMatch(/@layer base\s*\{[^}]*button\s*\{/s)
		expect(themeCss).toMatch(/button\[type='submit'\]/)
	})
	it('arb2b layout imports the shared file (no local token subset)', () => {
		expect.assertions(1)
		const layout = readFileSync(join(repoRoot, 'arb2b', 'src', 'routes', 'layout.css'), 'utf8')
		expect(layout).toMatch(/@import\s+['"]emw-lib\/theme\.css['"]/)
	})
})
