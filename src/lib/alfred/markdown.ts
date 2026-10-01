/**
 * Minimal markdown renderer for assistant `answer` bubbles
 * (plan `plans/ChatOutput.md` §1.3).
 *
 * Framework-free, dependency-free, XSS-safe by construction: the input is
 * escaped first, then a small subset of markdown is applied (code spans /
 * fenced blocks, bold, italic, strikethrough, links with `http(s):` only,
 * headings, unordered lists, blockquotes, paragraphs, line breaks).
 * Everything else renders as escaped plaintext. No `mermaid` / KaTeX yet —
 * fenced `mermaid` / `math` blocks render as plain code blocks for now
 * (full `markdown-it` + `markdown-it-katex` + `mermaid` + sanitizer lands
 * when the need arises; the `renderMarkdown` signature stays stable).
 */

/** Escape HTML special chars. */
function escapeHtml(s: string): string {
	return s
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;')
}

/** Inline subset: code spans, bold, italic, strike, links, autolinks. */
function inline(s: string): string {
	// Code spans first (protect contents from further formatting).
	const codes: string[] = []
	let out = escapeHtml(s).replace(/`([^`\n]+)`/g, (_m, code: string) => {
		codes.push(`<code>${code}</code>`)
		return `\u0000${codes.length - 1}\u0000`
	})
	out = out
		.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
		.replace(/__([^_]+)__/g, '<strong>$1</strong>')
		.replace(/\*([^*]+)\*/g, '<em>$1</em>')
		.replace(/(^|\W)_([^_]+)_(\W|$)/g, '$1<em>$2</em>$3')
		.replace(/~~([^~]+)~~/g, '<del>$1</del>')
		// Links: `[text](https://…)` only — other schemes render as text.
		.replace(
			/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
			'<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
		)
		// Bare autolinks.
		.replace(
			/(^|\s)(https?:\/\/[^\s<]+)/g,
			'$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>'
		)
	for (let i = 0; i < codes.length; i++) {
		out = out.replace(`\u0000${i}\u0000`, codes[i] as string)
	}
	return out
}

/** Render markdown to an HTML string (safe to inject via `{@html}`). */
export function renderMarkdown(src: string): string {
	const lines = src.replace(/\r\n?/g, '\n').split('\n')
	const blocks: string[] = []
	let i = 0
	while (i < lines.length) {
		const line = lines[i] as string
		// Fenced code block (incl. ```mermaid / ```math → plain code for now).
		const fence = /^```(\w*)\s*$/.exec(line)
		if (fence) {
			const lang = fence[1] ? ` class="language-${escapeHtml(fence[1])}"` : ''
			const code: string[] = []
			i++
			while (i < lines.length && !/^```\s*$/.test(lines[i] as string)) {
				code.push(lines[i] as string)
				i++
			}
			i++ // consume closing fence (or EOF)
			blocks.push(`<pre><code${lang}>${escapeHtml(code.join('\n'))}</code></pre>`)
			continue
		}
		// Heading.
		const heading = /^(#{1,6})\s+(.*)$/.exec(line)
		if (heading) {
			const level = (heading[1] as string).length
			blocks.push(`<h${level}>${inline((heading[2] as string).trim())}</h${level}>`)
			i++
			continue
		}
		// Blockquote.
		if (/^&gt;/.test(escapeHtml(line)) || /^>\s?/.test(line)) {
			const quote: string[] = []
			while (i < lines.length && /^>\s?/.test(lines[i] as string)) {
				quote.push((lines[i] as string).replace(/^>\s?/, ''))
				i++
			}
			blocks.push(`<blockquote>${inline(quote.join('\n'))}</blockquote>`)
			continue
		}
		// Unordered list.
		if (/^\s*[-*+]\s+/.test(line)) {
			const items: string[] = []
			while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i] as string)) {
				items.push((lines[i] as string).replace(/^\s*[-*+]\s+/, ''))
				i++
			}
			blocks.push(`<ul>${items.map((it) => `<li>${inline(it)}</li>`).join('')}</ul>`)
			continue
		}
		// Blank line → separator.
		if (/^\s*$/.test(line)) {
			i++
			continue
		}
		// Paragraph (collect until blank / block start).
		const para: string[] = [line]
		i++
		while (
			i < lines.length &&
			!/^\s*$/.test(lines[i] as string) &&
			!/^```/.test(lines[i] as string) &&
			!/^(#{1,6})\s+/.test(lines[i] as string) &&
			!/^>\s?/.test(lines[i] as string) &&
			!/^\s*[-*+]\s+/.test(lines[i] as string)
		) {
			para.push(lines[i] as string)
			i++
		}
		blocks.push(`<p>${para.map((l) => inline(l)).join('<br>')}</p>`)
	}
	return blocks.join('\n')
}
