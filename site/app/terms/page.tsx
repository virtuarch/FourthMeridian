import { LegalDocument } from "@site/components/LegalDocument";
import { loadLegalMarkdown } from "@site/lib/legal-content";
import { LEGAL } from "@site/content/copy";
import { pageMetadata } from "@site/lib/page-metadata";

export const metadata = pageMetadata(
  "/terms",
  "Terms of Service — Fourth Meridian",
  "The terms that govern your use of Fourth Meridian.",
);

export default function TermsPage() {
  return <LegalDocument title={LEGAL.terms.title} updated={LEGAL.terms.updated} markdown={loadLegalMarkdown("terms")} />;
}
