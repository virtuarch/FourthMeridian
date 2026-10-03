import type { Metadata, Viewport } from "next";
import { SiteNav } from "@site/components/SiteNav";
import { SiteFooter } from "@site/components/SiteFooter";
import { APP_LINKS, PUBLIC_CONFIG } from "@site/lib/public-config";
import ui from "@site/components/ui.module.css";
import "./globals.css";

const TITLE = "Fourth Meridian — Transform data into clarity";
const DESCRIPTION =
  "An intelligent financial ecosystem for individuals, families, and businesses—turning fragmented financial data into clarity and action.";

export const metadata: Metadata = {
  metadataBase: new URL(PUBLIC_CONFIG.siteOrigin),
  title: TITLE,
  description: DESCRIPTION,
  applicationName: "Fourth Meridian",
  alternates: { canonical: "/" },
  openGraph: { title: TITLE, description: DESCRIPTION, url: "/", siteName: "Fourth Meridian", type: "website" },
  twitter: { card: "summary", title: TITLE, description: DESCRIPTION },
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
