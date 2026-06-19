import type { Metadata, Viewport } from "next";
import { Providers } from "./providers";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"),
  title: "Fourth Meridian",
  description: "Personal finance dashboard — track your net worth, investments, crypto, and debt in one place.",
  manifest: "/manifest.json",
  // Favicon/browser-tab icon is wired via the Next.js App Router file
  // convention (app/favicon.ico + app/icon.png — the new black 4M mark),
  // which takes priority over this field. `apple` stays here since the
  // home-screen icon is a separate concern from the browser-tab favicon
  // and isn't part of this change.
  icons: {
    apple: "/icons/apple-touch-icon.png",
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Fourth Meridian",
  },
  openGraph: {
    title: "Fourth Meridian",
    description: "Personal finance dashboard — track your net worth, investments, crypto, and debt in one place.",
    // NOTE: url/images still point at the old fintracker.app domain and
    // og-image.png asset — left untouched since this pass is UI-branding
    // only and doesn't cover infrastructure (domain) or regenerating the
    // social-preview image. Flagged as a future enhancement.
    url: "https://fintracker.app",
    siteName: "Fourth Meridian",
    images: [
      {
        url: "/og-image.png",
        width: 1536,
        height: 1024,
        alt: "Fourth Meridian — Personal Finance Dashboard",
      },
    ],
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Fourth Meridian",
    description: "Personal finance dashboard — track your net worth, investments, crypto, and debt in one place.",
    images: ["/og-image.png"],
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: "#0a0f1e",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="h-full" suppressHydrationWarning>
      <head>
        <link rel="apple-touch-icon" sizes="180x180" href="/icons/apple-touch-icon.png" />
      </head>
      <body className="min-h-full flex flex-col">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
