import { describe, expect, it } from 'vitest'
import { renderMarkdown } from './markdown.js'

describe('renderMarkdown', () => {
	it('escapes raw HTML (XSS-safe by construction)', () => {
		expect(renderMarkdown('<script>alert(1)</script>')).not.toContain('<script>')
		expect(renderMarkdown('<script>alert(1)</script>')).toContain('&lt;script&gt;')
	})

	it('renders headings, bold, italic, code spans', () => {
		expect(renderMarkdown('# Hi')).toContain('<h1>Hi</h1>')
		expect(renderMarkdown('**b** and *i* and `c`')).toContain('<strong>b</strong>')
		expect(renderMarkdown('**b** and *i* and `c`')).toContain('<em>i</em>')
		expect(renderMarkdown('**b** and *i* and `c`')).toContain('<code>c</code>')
	})

	it('renders fenced code blocks (mermaid/math as plain code for now)', () => {
		const out = renderMarkdown('```mermaid\ngraph TD\n```')
		expect(out).toContain('<pre><code class="language-mermaid">')
		expect(out).toContain('graph TD')
	})

	it('renders links with http(s) only, lists, quotes', () => {
		expect(renderMarkdown('[x](https://a.b)')).toContain('<a href="https://a.b"')
		expect(renderMarkdown('[x](javascript:alert(1))')).not.toContain('<a href')
		expect(renderMarkdown('- a\n- b')).toContain('<ul>')
		expect(renderMarkdown('> q')).toContain('<blockquote>')
	})

	it('keeps newlines inside paragraphs', () => {
		expect(renderMarkdown('a\nb')).toContain('a<br>b')
	})
})
