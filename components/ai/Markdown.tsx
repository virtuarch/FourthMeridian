"use client";

/**
 * components/ai/Markdown.tsx  (AI Experience Convergence — AI-1)
 *
 * The themed Markdown renderer for AI answers — the `MD_COMPONENTS` override map
 * (moved verbatim from AnalyzeClient), mapping headings/lists/tables/code onto Atlas
 * ink tokens. Presentation only; the AnswerCard renders answer prose through it.
 *
 * ⚠️ HARDENING — THIS IS AN OUTPUT SINK FOR MODEL TEXT, AND MODEL TEXT CAN BE
 * STEERED BY DATA (a transaction description, an account name). react-markdown's
 * defaults render `![x](https://…)` as an <img> the browser FETCHES — a
 * zero-click channel that could carry figures to any host in the URL — and
 * `[x](https://…)` as a live link. The CSP is report-only and allows any https:
 * image, so this renderer is the boundary: no image is ever loaded (its alt text
 * is shown), and only same-origin relative links stay links. It holds even if
 * the model is fully manipulated; nothing here depends on the model refusing.
 */

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

// Defined once outside the render tree so the object reference is stable. Cast to
// `any` at the call site — react-markdown@8 component-map types are incompatible with
// React 19's JSX namespace changes.
const MD_COMPONENTS = {
  h1: ({ children }: { children: React.ReactNode }) => <p className="font-bold text-[17px] mt-5 first:mt-0 mb-2" style={{ color: "var(--text-primary)" }}>{children}</p>,
  h2: ({ children }: { children: React.ReactNode }) => <p className="font-bold text-base mt-5 first:mt-0 mb-1.5" style={{ color: "var(--text-primary)" }}>{children}</p>,
  h3: ({ children }: { children: React.ReactNode }) => <p className="font-semibold text-[15px] mt-4 first:mt-0 mb-1" style={{ color: "var(--text-primary)" }}>{children}</p>,
  p:  ({ children }: { children: React.ReactNode }) => <p className="mb-3 last:mb-0 leading-relaxed">{children}</p>,
  strong: ({ children }: { children: React.ReactNode }) => <strong className="font-semibold tabular-nums" style={{ color: "var(--text-primary)" }}>{children}</strong>,
  em: ({ children }: { children: React.ReactNode }) => <em className="italic" style={{ color: "var(--text-secondary)" }}>{children}</em>,
  ul: ({ children }: { children: React.ReactNode }) => <ul className="list-disc pl-5 mb-3 last:mb-0 space-y-1.5 marker:text-[var(--text-muted)]">{children}</ul>,
  ol: ({ children }: { children: React.ReactNode }) => <ol className="list-decimal pl-5 mb-3 last:mb-0 space-y-1.5 marker:text-[var(--text-muted)]">{children}</ol>,
  li: ({ children }: { children: React.ReactNode }) => <li className="leading-relaxed pl-1" style={{ color: "var(--text-secondary)" }}>{children}</li>,
  blockquote: ({ children }: { children: React.ReactNode }) => (
    <blockquote className="border-l-2 pl-3 py-0.5 italic mb-3" style={{ borderColor: "var(--border-hairline-strong)", color: "var(--text-secondary)" }}>{children}</blockquote>
  ),
  code: ({ children, className }: { children: React.ReactNode; className?: string }) =>
    className ? (
      <pre className="border rounded-xl p-3 overflow-x-auto mb-3 text-xs font-mono leading-relaxed" style={{ background: "var(--surface-inset)", borderColor: "var(--border-hairline)", color: "var(--text-secondary)" }}>
        <code>{children}</code>
      </pre>
    ) : (
      <code className="rounded px-1.5 py-0.5 text-[13px] font-mono tabular-nums" style={{ background: "var(--surface-inset)", color: "var(--text-secondary)" }}>{children}</code>
    ),
  pre: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  hr: () => <hr className="my-3" style={{ borderColor: "var(--border-hairline)" }} />,
  img: ({ alt }: { alt?: string }) => (alt ? <span data-md-image-removed="">[{alt}]</span> : null),
  a: ({ href, children }: { href?: string; children: React.ReactNode }) =>
    isSameOriginPath(href) ? (
      <a href={href} className="underline underline-offset-2" style={{ color: "var(--text-primary)" }}>{children}</a>
    ) : (
      <span data-md-link-removed="">{children}</span>
    ),
  table: ({ children }: { children: React.ReactNode }) => (
    <div className="overflow-x-auto my-3 rounded-xl border" style={{ borderColor: "var(--border-hairline)" }}>
      <table className="min-w-full text-[13px] border-collapse tabular-nums">{children}</table>
    </div>
  ),
  thead: ({ children }: { children: React.ReactNode }) => <thead style={{ background: "var(--surface-inset)" }}>{children}</thead>,
  tbody: ({ children }: { children: React.ReactNode }) => <tbody className="divide-y divide-[var(--border-hairline)]">{children}</tbody>,
  tr: ({ children }: { children: React.ReactNode }) => <tr>{children}</tr>,
  th: ({ children }: { children: React.ReactNode }) => <th className="px-3.5 py-2 text-left font-semibold whitespace-nowrap border-b" style={{ color: "var(--text-secondary)", borderColor: "var(--border-hairline)" }}>{children}</th>,
  td: ({ children }: { children: React.ReactNode }) => <td className="px-3.5 py-2 align-top whitespace-nowrap" style={{ color: "var(--text-secondary)" }}>{children}</td>,
};

/** A link that stays on this site: a root-relative path, never `//host` or a scheme. */
export function isSameOriginPath(href: string | undefined): href is string {
  return typeof href === "string" && /^\/(?!\/)/.test(href) && !/[\\\s]/.test(href);
}

export function Markdown({ children }: { children: string }) {
  return (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS as any}>
      {children}
    </ReactMarkdown>
  );
}
