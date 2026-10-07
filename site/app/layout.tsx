import type { Metadata, Viewport } from "next";
import { SiteNav } from "@site/components/SiteNav";
import { SiteFooter } from "@site/components/SiteFooter";
import { APP_LINKS, PUBLIC_CONFIG } from "@site/lib/public-config";
import ui from "@site/components/ui.module.css";
import "./globals.css";

const TITLE = "Fourth Meridian — AI-native wealth management";
// The canonical positioning (content/copy.ts SITE.positioning), then what the
// shipped product does, then its status. Nothing here is roadmap.
const DESCRIPTION =
  "Fourth Meridian is an AI-native wealth management platform: one continuously updated understanding of your cash, spending, income, debt and investments, with a Daily Brief and Conversations grounded in your own numbers. Closed beta, invite-only.";

export const metadata: Metadata = {
  metadataBase: new URL(PUBLIC_CONFIG.siteOrigin),
  title: TITLE,
  description: DESCRIPTION,
  applicationName: "Fourth Meridian",
  alternates: { canonical: "/" },
  openGraph: { title: TITLE, description: DESCRIPTION, url: "/", siteName: "Fourth Meridian", type: "website" },
  twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION },
  // Only the Production site origin is indexable; Preview and local builds say
  // noindex in every page as well as in robots.txt.
  robots: PUBLIC_CONFIG.indexable ? { index: true, follow: true } : { index: false, follow: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#060911",
  colorScheme: "dark",
};

/**
 * The public site's root layout. No session provider, no theme provider, no app
 * provider of any kind: nothing here knows or asks whether the visitor is signed
 * in. Links into the application are plain absolute URLs.
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className={ui.shell}>
          <SiteNav signInHref={APP_LINKS.signIn()} requestAccessHref={APP_LINKS.requestAccess()} />
          <main className={ui.main}>{children}</main>
          <SiteFooter />
        </div>
      </body>
    </html>
  );
}
