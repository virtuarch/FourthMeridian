/**
 * app/(public)/privacy/page.tsx — Privacy Policy.
 *
 * Server-only. Long-form text lives as Markdown (content/marketing/privacy.md)
 * and is rendered via react-markdown.
 */

import type { Metadata } from "next";
import { LegalDocument } from "@/components/marketing/LegalDocument";
import { loadLegalMarkdown } from "@/lib/marketing/legal-content";
import { LEGAL } from "@/content/marketing/copy";

export const metadata: Metadata = {
  title: "Privacy Policy — Fourth Meridian",
  description: "What Fourth Meridian collects, how we use it, and the choices you have.",
};

export default function PrivacyPage() {
  return (
    <LegalDocument
      title={LEGAL.privacy.title}
      updated={LEGAL.privacy.updated}
      markdown={loadLegalMarkdown("privacy")}
    />
  );
}
