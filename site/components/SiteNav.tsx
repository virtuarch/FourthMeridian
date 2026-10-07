"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Container } from "./Container";
import { Wordmark } from "./Wordmark";
import { AppLink } from "./AppLink";
import styles from "./SiteNav.module.css";

const links = [
  { label: "Product", href: "/#product" },
  { label: "Vision", href: "/#vision" },
  { label: "About", href: "/#about" },
] as const;

/**
 * The application links arrive as PROPS from the server layout, already
 * absolute. This client island never reads configuration or the environment,
 * and it does not know (or try to learn) whether the visitor is signed in:
 * "Sign in" is a plain top-level navigation, and the app decides. "Get Started"
 * is an AppLink: the same navigation, carrying the page's acquisition context
 * (lib/acquisition.ts) so a campaign or referrer survives the click.
 */
export interface SiteNavProps {
  signInHref: string;
  requestAccessHref: string;
}

function MenuIcon({ open }: { open: boolean }) {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {open ? <path d="M18 6 6 18M6 6l12 12" /> : <path d="M4 6h16M4 12h16M4 18h16" />}
    </svg>
  );
}

export function SiteNav({ signInHref, requestAccessHref }: SiteNavProps) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const close = () => setOpen(false);
    window.addEventListener("resize", close);
    return () => window.removeEventListener("resize", close);
  }, []);

  return (
    <header className={styles.header}>
      <Container className={styles.bar}>
        <Link href="/" aria-label="Fourth Meridian home" className={styles.brand}><Wordmark /></Link>
        <nav className={styles.desktopNav} aria-label="Primary navigation">
          {links.map((link) => <Link key={link.href} href={link.href}>{link.label}</Link>)}
        </nav>
        <div className={styles.actions}>
          <a className={styles.signIn} href={signInHref}>Sign In</a>
          <AppLink className={styles.cta} href={requestAccessHref}>Get Started</AppLink>
          <button className={styles.menuButton} type="button" aria-expanded={open} aria-controls="mobile-site-menu" aria-label={open ? "Close menu" : "Open menu"} onClick={() => setOpen((value) => !value)}><MenuIcon open={open} /></button>
        </div>
      </Container>
      {open && (
        <nav id="mobile-site-menu" className={styles.mobileNav} aria-label="Mobile navigation">
          {links.map((link) => <Link key={link.href} href={link.href} onClick={() => setOpen(false)}>{link.label}</Link>)}
          <a href={signInHref} onClick={() => setOpen(false)}>Sign In</a>
        </nav>
      )}
    </header>
  );
}
