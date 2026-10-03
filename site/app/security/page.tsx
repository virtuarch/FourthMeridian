import { PageHeader } from "@site/components/PageHeader";
import { Container } from "@site/components/Container";
import { SECURITY } from "@site/content/copy";
import { pageMetadata } from "@site/lib/page-metadata";
import ui from "@site/components/ui.module.css";

export const metadata = pageMetadata(
  "/security",
  "Security — Fourth Meridian",
  "How Fourth Meridian protects your financial data: encrypted credentials, two-factor authentication, least-privilege access, audit logging, and rate limiting.",
);

export default function SecurityPage() {
  return (
    <>
      <PageHeader heading={SECURITY.heading} intro={SECURITY.intro} />
      <Container className={ui.section}>
        <div className={ui.grid}>
          {SECURITY.pillars.map((pillar) => (
            <div key={pillar.title} className={ui.card}>
              <h2 className={ui.cardTitle}>{pillar.title}</h2>
              <p className={ui.cardBody}>{pillar.body}</p>
            </div>
          ))}
        </div>
        <p className={ui.footnote}>{SECURITY.footnote}</p>
      </Container>
    </>
  );
}
