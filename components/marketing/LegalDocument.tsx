/**
 * components/marketing/LegalDocument.tsx
 *
 * Server-only renderer for the long-form legal pages (terms, privacy, AI).
 * Renders Markdown via react-markdown (already installed, package.json) rather
 * than hand-writing JSX for long legal text — the house rule from the
 * investigation §3.
 *
 * react-markdown v8 uses no client-only hooks, so it renders fine inside a
 * server component (verified: no "use client"/useState/useEffect in its lib).
 * Styling maps each element to the globals.css design tokens via the
 * `components` override — the marketing pages never import the app's client
 * component library.
 */

import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Container } from "./Container";

const markdownComponents: Components = {
  h2: ({ children }) => (
    <h2
      className="mt-10 mb-3 text-xl font-semibold tracking-tight"
      style={{ color: "var(--text-primary)" }}
    >
      {children}
    </h2>
  ),
  h3: ({ children }) => (
    <h3
      className="mt-6 mb-2 text-base font-semibold"
      style={{ color: "var(--text-primary)" }}
    >
      {children}
    </h3>
  ),
  p: ({ children }) => (
    <p
      className="my-4 text-[15px] leading-relaxed"
      style={{ color: "var(--text-secondary)" }}
    >
      {children}
    </p>
  ),
  ul: ({ children }) => (
    <ul
      className="my-4 list-disc space-y-2 pl-5 text-[15px] leading-relaxed"
      style={{ color: "var(--text-secondary)" }}
    >
      {children}
    </ul>
  ),
  ol: ({ children }) => (
    <ol
      className="my-4 list-decimal space-y-2 pl-5 text-[15px] leading-relaxed"
      style={{ color: "var(--text-secondary)" }}
    >
      {children}
    </ol>
  ),
  li: ({ children }) => <li className="pl-1">{children}</li>,
  strong: ({ children }) => (
    <strong className="font-semibold" style={{ color: "var(--text-primary)" }}>
      {children}
    </strong>
  ),
  a: ({ href, children }) => (
    <a
      href={href}
      className="underline underline-offset-2 transition-colors hover:opacity-80"
      style={{ color: "var(--meridian-400)" }}
    >
      {children}
    </a>
  ),
};

export function LegalDocument({
  title,
  updated,
  markdown,
}: {
  title: string;
  updated: string;
  markdown: string;
}) {
  return (
    <Container className="pt-16 pb-8 sm:pt-24">
      <div className="mx-auto max-w-3xl">
        <h1
          className="text-3xl font-bold tracking-tight sm:text-4xl"
          style={{ color: "var(--text-primary)" }}
        >
          {title}
        </h1>
        <p className="mt-2 text-sm" style={{ color: "var(--text-muted)" }}>
          Last updated {updated}
        </p>
        <div className="mt-8">
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
            {markdown}
          </ReactMarkdown>
        </div>
      </div>
    </Container>
  );
}
