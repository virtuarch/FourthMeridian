"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Menu, X } from "lucide-react";
import { Container } from "./Container";
import { Wordmark } from "./Wordmark";
import styles from "./MarketingNav.module.css";
import { PUBLIC_SITE_ORIGIN, publicSiteHref } from "@/lib/marketing/public-site";

// Site-owned pages: absolute on the public site once one is configured
// (domain split), relative while the application still serves them.
const links = [
  { label: "Product", href: publicSiteHref("/#product", PUBLIC_SITE_ORIGIN) },
  { label: "Vision", href: publicSiteHref("/#vision", PUBLIC_SITE_ORIGIN) },
  { label: "About", href: publicSiteHref("/#about", PUBLIC_SITE_ORIGIN) },
] as const;
const homeHref = publicSiteHref("/", PUBLIC_SITE_ORIGIN);

export function MarketingNav() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const close = () => setOpen(false);
    window.addEventListener("resize", close);
    return () => window.removeEventListener("resize", close);
  }, []);

  return (
    <header className={styles.header}>
      <Container className={styles.bar}>
        <Link href={homeHref} aria-label="Fourth Meridian home" className={styles.brand}><Wordmark /></Link>
        <nav className={styles.desktopNav} aria-label="Primary navigation">
          {links.map((link) => <Link key={link.href} href={link.href}>{link.label}</Link>)}
        </nav>
        <div className={styles.actions}>
          <Link className={styles.signIn} href="/login">Sign In</Link>
          <Link className={styles.cta} href="/request-access">Get Started</Link>
          <button className={styles.menuButton} type="button" aria-expanded={open} aria-controls="mobile-marketing-menu" aria-label={open ? "Close menu" : "Open menu"} onClick={() => setOpen((value) => !value)}>{open ? <X size={20} /> : <Menu size={20} />}</button>
        </div>
      </Container>
      {open && <nav id="mobile-marketing-menu" className={styles.mobileNav} aria-label="Mobile navigation">{links.map((link) => <Link key={link.href} href={link.href} onClick={() => setOpen(false)}>{link.label}</Link>)}<Link href="/login" onClick={() => setOpen(false)}>Sign In</Link></nav>}
    </header>
  );
}
