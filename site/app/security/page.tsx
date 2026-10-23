import { PageHeader } from "@site/components/PageHeader";
import { Container } from "@site/components/Container";
import { SECURITY, SUPPORT_EMAIL } from "@site/content/copy";
import { pageMetadata } from "@site/lib/page-metadata";
import ui from "@site/components/ui.module.css";

export const metadata = pageMetadata(
  "/security",
  "Security — Fourth Meridian",
  "How Fourth Meridian protects your financial data today: bcrypt-hashed passwords, AES-256-GCM encrypted bank tokens, read-only connections, two-factor authentication, audit logging, rate limiting, export and a seven-day deletion window.",
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
        <p className={ui.footnote}>
          {SECURITY.footnote}{" "}
          {/* The published support destination — a plain mailto, no form, no API (this site has neither). */}
          <a className={ui.quietLink} href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>
        </p>
      </Container>
    </>
  );
}
