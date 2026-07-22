/**
 * app/(public)/legal/ai/page.tsx — AI disclosures.
 *
 * Server-only. Long-form text lives as Markdown (content/marketing/legal-ai.md)
 * and is rendered via react-markdown.
 */

import type { Metadata } from "next";
import { LegalDocument } from "@/components/marketing/LegalDocument";
import { loadLegalMarkdown } from "@/lib/marketing/legal-content";
import { LEGAL } from "@/content/marketing/copy";

export const metadata: Metadata = {
  title: "AI Disclosures — Fourth Meridian",
  description:
    "How Fourth Meridian uses AI to generate briefings, what's shared with model " +
    "providers, and the limits of AI-generated output.",
};

export default function LegalAiPage() {
  return (
    <LegalDocument
      title={LEGAL.ai.title}
      updated={LEGAL.ai.updated}
      markdown={loadLegalMarkdown("ai")}
    />
  );
}
