import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Container } from "./Container";
import ui from "./ui.module.css";

// react-markdown 10 (React 19 types natively; the app's v8 needs a global JSX
// shim). The legal documents use headings, paragraphs, lists, bold and links
// only, which both versions render to the same elements.
const markdownComponents: Components = {
  h2: ({ children }) => <h2 className={ui.md_h2}>{children}</h2>,
  h3: ({ children }) => <h3 className={ui.md_h3}>{children}</h3>,
  p: ({ children }) => <p className={ui.md_p}>{children}</p>,
  ul: ({ children }) => <ul className={ui.md_ul}>{children}</ul>,
  ol: ({ children }) => <ol className={ui.md_ol}>{children}</ol>,
  li: ({ children }) => <li className={ui.md_li}>{children}</li>,
  strong: ({ children }) => <strong className={ui.md_strong}>{children}</strong>,
  a: ({ href, children }) => <a href={href} className={ui.md_a}>{children}</a>,
};

/** Long-form legal page, rendered from Markdown at build time. */
export function LegalDocument({ title, updated, markdown }: { title: string; updated: string; markdown: string }) {
  return (
    <Container className={ui.pageTop}>
      <div className={ui.legal}>
        <h1 className={ui.legalTitle}>{title}</h1>
        <p className={ui.legalUpdated}>Last updated {updated}</p>
        <div className={ui.legalBody}>
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{markdown}</ReactMarkdown>
        </div>
      </div>
    </Container>
  );
}
