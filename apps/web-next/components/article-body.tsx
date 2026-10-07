import ReactMarkdown from 'react-markdown'
import rehypeSanitize from 'rehype-sanitize'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism'

/**
 * The article body, rendered **on the server** (design D-5).
 *
 * No `'use client'` anywhere in this file, and that is load-bearing: the markdown
 * pipeline runs while the page is being produced, so the sanitized HTML is in the bytes
 * the server writes — the ones a crawler or a link-preview bot reads — and neither
 * `react-markdown` nor `refractor` ships to the browser.
 *
 * `react-markdown@9`'s default export is the synchronous renderer
 * (`processor.runSync`); its `MarkdownHooks` sibling deliberately renders nothing on
 * the first pass, which would have put an empty `<article>` in the HTML. Worth naming
 * because it is the one thing about this port that had no visible symptom in the SPA.
 *
 * Sanitize: **added**, not inherited. The SPA's public render path does *not* run
 * `rehype-sanitize` — it is only wired into `MDEditor`'s preview here and in the admin
 * editor (grep: `ArticleDetail.tsx:622`, `AdminArticleEditor.tsx:450`), so
 * `packages/../pages/ArticleDetail.tsx`'s `<ReactMarkdown>` had no sanitizer in front
 * of it. The bodies come from `.md` imports and sanitize is the only gate before they
 * become `<img>`/`<a>`, so S4-R6 puts it here. Order is react-markdown's own:
 * remark → remark-rehype → rehypePlugins (sanitize) → `urlTransform` → JSX.
 * Measured consequence: `language-*` classes on `<code>` survive the default schema,
 * so syntax highlighting is unchanged; `javascript:` hrefs and event-handler
 * attributes do not survive.
 */
export default function ArticleBody({ content }: { content: string }) {
  return (
    <article className="prose prose-neutral dark:prose-invert prose-blue max-w-none">
      <ReactMarkdown
        rehypePlugins={[rehypeSanitize]}
        components={{
          // `node` is destructured only to keep it out of `...props`.
          // Spreading react-markdown's AST node onto a DOM element would
          // make React log an unknown-prop warning.
          code({ node: _node, className, children, ...props }) {
            const match = /language-(\w+)/.exec(className || '')
            return match ? (
              // `...props` is deliberately NOT spread here. Those are HTML `<code>`
              // attributes, and SyntaxHighlighter's `style` means something entirely
              // different — the highlight theme.
              <SyntaxHighlighter style={vscDarkPlus} language={match[1]} PreTag="div">
                {String(children).replace(/\n$/, '')}
              </SyntaxHighlighter>
            ) : (
              <code className={className} {...props}>
                {children}
              </code>
            )
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </article>
  )
}
