import { LegalDocument } from "@site/components/LegalDocument";
import { loadLegalMarkdown } from "@site/lib/legal-content";
import { LEGAL } from "@site/content/copy";
import { pageMetadata } from "@site/lib/page-metadata";

export const metadata = pageMetadata(
  "/privacy",
  "Privacy Policy — Fourth Meridian",
  "What Fourth Meridian collects, how we use it, and the choices you have.",
);

export default function PrivacyPage() {
  return <LegalDocument title={LEGAL.privacy.title} updated={LEGAL.privacy.updated} markdown={loadLegalMarkdown("privacy")} />;
}
