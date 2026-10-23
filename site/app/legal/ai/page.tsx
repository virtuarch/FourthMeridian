import { LegalDocument } from "@site/components/LegalDocument";
import { loadLegalMarkdown } from "@site/lib/legal-content";
import { LEGAL } from "@site/content/copy";
import { pageMetadata } from "@site/lib/page-metadata";

export const metadata = pageMetadata(
  "/legal/ai",
  "AI Disclosures — Fourth Meridian",
  "How Fourth Meridian uses AI in the Daily Brief and Conversations, what is sent to OpenAI, what Fourth Meridian remembers, and the limits of AI-generated output.",
);

export default function LegalAiPage() {
  return <LegalDocument title={LEGAL.ai.title} updated={LEGAL.ai.updated} markdown={loadLegalMarkdown("ai")} />;
}
