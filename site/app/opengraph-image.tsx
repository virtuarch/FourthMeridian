import { readFileSync } from "node:fs";
import path from "node:path";
import { ImageResponse } from "next/og";

/**
 * The social-preview image (Open Graph / Twitter) for every page of the site.
 *
 * STATIC. Rendered once at build time into the export (`dynamic = "force-static"`,
 * like robots.ts and sitemap.ts); there is no server, no request and no
 * runtime code path behind it. It reads nothing but the mark in public/brand
 * and states nothing but the canonical positioning.
 */
export const dynamic = "force-static";
export const alt = "Fourth Meridian — an AI-native wealth management platform";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const MARK = `data:image/png;base64,${readFileSync(path.join(process.cwd(), "public", "brand", "fm-mark-dark-128.png")).toString("base64")}`;

export default function OpenGraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "72px 84px",
          background: "linear-gradient(160deg, #060911 0%, #0b1322 60%, #0f1b30 100%)",
          color: "#f3f5f9",
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 24 }}>
          <img src={MARK} width={72} height={72} alt="" />
          <div style={{ fontSize: 40, fontWeight: 600, letterSpacing: -0.5 }}>Fourth Meridian</div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 28 }}>
          <div style={{ fontSize: 64, fontWeight: 600, lineHeight: 1.08, letterSpacing: -1.5, maxWidth: 1000 }}>
            An AI-native wealth management platform.
          </div>
          <div style={{ fontSize: 30, lineHeight: 1.35, color: "#b7c0d1", maxWidth: 1000 }}>
            One continuously updated understanding of your cash, spending, income, debt and investments.
          </div>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 24, color: "#8b96ab" }}>
          <span>fourthmeridian.com</span>
          <span>Closed beta · invite-only</span>
        </div>
      </div>
    ),
    size,
  );
}
