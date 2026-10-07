import Link from "next/link";
import { Container } from "./Container";
import { SITE, SUPPORT_EMAIL } from "@site/content/copy";
import { APP_LINKS } from "@site/lib/public-config";
import ui from "./ui.module.css";

const FOOTER_LINKS = [
  { label: "Security", href: "/security" },
  { label: "About", href: "/about" },
  { label: "Get Started", href: "/request-access" }, // the on-site page, which hands off to the app
  { label: "Terms", href: "/terms" },
  { label: "Privacy", href: "/privacy" },
  { label: "AI disclosures", href: "/legal/ai" },
] as const;

/** Site footer: on-site pages, the support address, plus one plain navigation into the app. */
export function SiteFooter() {
  return (
    <footer className={ui.footer}>
      <Container className={ui.footerInner}>
        <nav className={ui.footerNav} aria-label="Footer">
          {FOOTER_LINKS.map((link) => (
            <Link key={link.href} href={link.href} className={ui.footerLink}>{link.label}</Link>
          ))}
          <a href={`mailto:${SUPPORT_EMAIL}`} className={ui.footerLink}>Support</a>
          <a href={APP_LINKS.signIn()} className={ui.footerLink}>Sign in</a>
        </nav>
        <p className={ui.copyright}>© 2026 {SITE.name}. All rights reserved.</p>
      </Container>
    </footer>
  );
}
