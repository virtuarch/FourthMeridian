import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV === "development";

// Extra LAN IPs or hostnames allowed to access the dev server (e.g. a phone
// on your local network). Comma-separated in DEV_ALLOWED_ORIGINS.
// Only applied in development — allowedDevOrigins has no effect in production
// and emits a warning if set there.
const extraOrigins = isDev && process.env.DEV_ALLOWED_ORIGINS
  ? process.env.DEV_ALLOWED_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean)
  : [];

// ── Security headers (OPS-1 S5) ───────────────────────────────────────────────
//
// Applied to every route. Deliberate choices, documented per the plan:
//
//   - HSTS: production only (a dev server on plain http must not pin HTTPS for
//     localhost). 180-day max-age per SECURITY_CHECKLIST; add `preload` later
//     once confident.
//   - Clickjacking: ENFORCED via X-Frame-Options: DENY (nothing embeds this
//     app). CSP frame-ancestors 'none' repeats it inside the policy.
//   - CSP ships REPORT-ONLY first (per OPS-1 plan Slice 5): Next.js inline
//     bootstrap scripts, Plaid Link (cdn.plaid.com script + iframe,
//     *.plaid.com connect) and the TradingView widget (s3.tradingview.com
//     script, tradingview iframes) are known constraint points. The flip to
//     enforcing Content-Security-Policy is its own commit after a clean
//     report-only window. 'unsafe-inline'/'unsafe-eval' in script-src are the
//     conservative Next.js-compatible start (no nonce plumbing yet).
//   - Resend/email links, OpenAI calls: server-side only — no CSP impact.
export const CSP_REPORT_ONLY_VALUE = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.plaid.com https://s3.tradingview.com",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self' https://*.plaid.com https://*.tradingview.com wss://*.tradingview.com",
  "frame-src https://cdn.plaid.com https://*.plaid.com https://*.tradingview.com https://*.tradingview-widget.com",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

export const SECURITY_HEADERS: { key: string; value: string }[] = [
  ...(isDev
    ? []
    : [{ key: "Strict-Transport-Security", value: "max-age=15552000; includeSubDomains" }]),
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()" },
  { key: "Content-Security-Policy-Report-Only", value: CSP_REPORT_ONLY_VALUE },
];

const nextConfig: NextConfig = {
  ...(isDev && {
    allowedDevOrigins: ["127.0.0.1", "localhost", ...extraOrigins],
  }),
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: SECURITY_HEADERS,
      },
    ];
  },
};

export default nextConfig;
