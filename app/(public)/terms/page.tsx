/**
 * app/(public)/terms/page.tsx — Terms of Service.
 *
 * Server-only. Long-form text lives as Markdown (content/marketing/terms.md)
 * and is rendered via react-markdown — no hand-written JSX for legal text.
 */

import type { Metadata } from "next";
import { LegalDocument } from "@/components/marketing/LegalDocument";
import { loadLegalMarkdown } from "@/lib/marketing/legal-content";
import { LEGAL } from "@/content/marketing/copy";

export const metadata: Metadata = {
  title: "Terms of Service — Fourth Meridian",
  description: "The terms that govern your use of Fourth Meridian.",
};

export default function TermsPage() {
  return (
    <LegalDocument
      title={LEGAL.terms.title}
      updated={LEGAL.terms.updated}
      markdown={loadLegalMarkdown("terms")}
    />
  );
}
