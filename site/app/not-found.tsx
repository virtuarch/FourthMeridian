import Link from "next/link";
import { Container } from "@site/components/Container";
import { APP_LINKS, PUBLIC_CONFIG } from "@site/lib/public-config";
import { legacyAppForwardScript } from "@site/lib/legacy-app-paths";
import ui from "@site/components/ui.module.css";

export default function NotFound() {
  return (
    <Container className={ui.notFound}>
      {/* Application paths that used to be served on this host (old emails,
          bookmarks) continue on the application origin — lib/legacy-app-paths.ts. */}
      <script dangerouslySetInnerHTML={{ __html: legacyAppForwardScript(PUBLIC_CONFIG.appOrigin) }} />
      <p className={ui.eyebrow}>Not found</p>
      <h1 className={ui.heading}>This page isn&apos;t here.</h1>
      <p className={ui.intro}>If you were heading into your Fourth Meridian account, sign in to the application.</p>
      <div className={ui.actions}>
        <a className={ui.button} href={APP_LINKS.signIn()}>Sign in</a>
        <Link className={ui.quietLink} href="/">Fourth Meridian home</Link>
      </div>
    </Container>
  );
}
