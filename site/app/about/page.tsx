import Link from "next/link";
import { PageHeader } from "@site/components/PageHeader";
import { Container } from "@site/components/Container";
import { ABOUT } from "@site/content/copy";
import { pageMetadata } from "@site/lib/page-metadata";
import ui from "@site/components/ui.module.css";

export const metadata = pageMetadata(
  "/about",
  "About — Fourth Meridian",
  "Why Fourth Meridian exists: one honest reading of your financial position, built to be trusted more and looked at less.",
);

export default function AboutPage() {
  return (
    <>
      <PageHeader heading={ABOUT.heading} />
      <Container className={ui.section}>
        <div className={ui.prose}>
          {ABOUT.paragraphs.map((paragraph, i) => <p key={i} className={ui.lead}>{paragraph}</p>)}
        </div>
        <div className={ui.actions}>
          {/* ABOUT.cta.href is the on-site /request-access page, which hands off to the app. */}
          <Link href={ABOUT.cta.href} className={ui.button}>{ABOUT.cta.label}</Link>
        </div>
      </Container>
    </>
  );
}
