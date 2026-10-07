import { PageHeader } from "@site/components/PageHeader";
import { Container } from "@site/components/Container";
import { REQUEST_ACCESS } from "@site/content/copy";
import { APP_LINKS } from "@site/lib/public-config";
import { AppLink } from "@site/components/AppLink";
import { pageMetadata } from "@site/lib/page-metadata";
import ui from "@site/components/ui.module.css";

export const metadata = pageMetadata(
  "/request-access",
  "Request access — Fourth Meridian",
  "Fourth Meridian is invite-only while in beta. Leave your email and we'll reach out when a spot opens.",
);

/**
 * The request is made in the APPLICATION, not here. This site has no API, no
 * CAPTCHA secret and no database, so it cannot accept a submission, and it does
 * not post one across origins. The page keeps fourthmeridian.com/request-access
 * meaningful for existing links and hands the visitor to the app's own form —
 * through an AppLink, so utm_* / ref / source on THIS page's URL and the page
 * path reach the form (lib/acquisition.ts) instead of dying at the hand-off.
 */
export default function RequestAccessPage() {
  return (
    <>
      <PageHeader heading={REQUEST_ACCESS.heading} intro={REQUEST_ACCESS.intro} />
      <Container className={ui.section}>
        <div className={ui.actions}>
          <AppLink className={ui.button} href={APP_LINKS.requestAccess()}>Continue to request access</AppLink>
          <a className={ui.quietLink} href={APP_LINKS.signIn()}>Already have access? Sign in</a>
        </div>
      </Container>
    </>
  );
}
