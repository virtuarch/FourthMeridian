/**
 * lib/email/design/design.test.ts
 *
 * Behavioural guards for the email design system and the beta approval email
 * built on it. Standalone tsx script (house pattern):
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/email/design/design.test.ts
 *
 * No DB, no network.
 *   1. Palette parity with app/globals.css + WCAG AA contrast of every text pair.
 *   2. Site-origin parity with site/lib/public-config.ts; env override.
 *   3. Validity days + labelled UTC expiry across DST boundaries and month ends.
 *   4. Escaping: a malicious name / URL never reaches the HTML raw.
 *   5. The beta invite: HTML and text parts carry the same CTA URL and expiry;
 *      alt text + text wordmark; legal links on the site origin; email-client
 *      structure (presentation tables, preheader, dark mode, 600 px).
 *   6. The security variant admits only security-email blocks.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { BRASS, DARK, INK, LIGHT, MERIDIAN } from "@/lib/email/design/tokens";
import { PRODUCTION_SITE_ORIGIN, resolveEmailSiteOrigin, type EmailBrandConfig } from "@/lib/email/design/config";
import { daysPhrase, formatUtcDateTimeLabelled, wholeDaysBetween } from "@/lib/email/design/datetime";
import { cleanText, escapeHtml, safeHttpUrl } from "@/lib/email/design/escape";
import { renderEmail, renderSecurityEmail } from "@/lib/email/design/render";
import { betaInviteTemplate, renderBetaInvite, BETA_INVITE_SUBJECT, BETA_DIRECT_INVITE_SUBJECT } from "@/lib/email/templates/beta-invite";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name}${detail !== undefined ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  }
}
function throws(fn: () => unknown): boolean {
  try { fn(); return false; } catch { return true; }
}

const ROOT = process.cwd();
const BRAND: EmailBrandConfig = { siteOrigin: "https://site.example.test", supportEmail: "help@example.test" };
const DAY = 24 * 60 * 60 * 1000;
const URL_OK = "https://app.example.test/register?invite=0123456789abcdef";

// ── 1. palette ───────────────────────────────────────────────────────────────
console.log("1. palette parity + contrast");
{
  const css = readFileSync(path.join(ROOT, "app/globals.css"), "utf8");
  const token = (name: string) => css.match(new RegExp(`--${name}:\\s*(#[0-9A-Fa-f]{6})`))?.[1]?.toUpperCase();
  const pairs: [string, string][] = [
    ...Object.entries(INK).map(([k, v]) => [`ink-${k}`, v] as [string, string]),
    ...Object.entries(BRASS).map(([k, v]) => [`brass-${k}`, v] as [string, string]),
    ...Object.entries(MERIDIAN).map(([k, v]) => [`meridian-${k}`, v] as [string, string]),
  ];
  const drift = pairs.filter(([n, v]) => token(n) !== v.toUpperCase());
  check("every email colour equals its app/globals.css token", drift.length === 0, drift);
  check("CTA is Meridian 600 #2563EB", LIGHT.ctaBg === "#2563EB" && DARK.ctaBg === "#2563EB");

  const lum = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (a: string, b: string) => {
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
  };
  for (const [scheme, c] of [["light", LIGHT], ["dark", DARK]] as const) {
    const textPairs: [string, string, string][] = [
      ["body text on card", c.text, c.card],
      ["heading on card", c.heading, c.card],
      ["muted on card", c.muted, c.card],
      ["muted footer on canvas", c.muted, c.canvas],
      ["link on card", c.link, c.card],
      ["text on panel", c.text, c.panel],
      ["heading on panel", c.heading, c.panel],
      ["CTA label on CTA fill", c.ctaText, c.ctaBg],
    ];
    for (const [label, fg, bg] of textPairs) {
      const r = ratio(fg, bg);
      check(`${scheme}: ${label} ≥ 4.5:1 (WCAG AA)`, r >= 4.5, r.toFixed(2));
    }
  }
}

// ── 2. site origin ───────────────────────────────────────────────────────────
console.log("2. site origin");
{
  const site = readFileSync(path.join(ROOT, "site/lib/public-config.ts"), "utf8");
  const m = site.match(/export const PRODUCTION_SITE_ORIGIN = "([^"]+)"/);
  check("PRODUCTION_SITE_ORIGIN equals site/lib/public-config.ts", m?.[1] === PRODUCTION_SITE_ORIGIN, m?.[1]);
  check("NEXT_PUBLIC_SITE_URL wins when valid", resolveEmailSiteOrigin("https://preview.example.test") === "https://preview.example.test");
  check("unset → Production site origin", resolveEmailSiteOrigin(undefined) === PRODUCTION_SITE_ORIGIN);
  check("invalid (javascript:) → Production site origin", resolveEmailSiteOrigin("javascript:alert(1)") === PRODUCTION_SITE_ORIGIN);
}

// ── 3. validity + expiry wording ─────────────────────────────────────────────
console.log("3. validity days + labelled UTC expiry");
{
  const cases: { label: string; issued: string; days: number; expect: string }[] = [
    // US DST starts Sun 2026-03-08; a 7-day TTL issued before it is still 7 UTC days.
    { label: "across US DST start", issued: "2026-03-05T15:04:00Z", days: 7, expect: "Thursday, March 12, 2026 at 3:04 PM UTC" },
    // EU DST ends Sun 2026-10-25, US ends Sun 2026-11-01.
    { label: "across EU+US DST end", issued: "2026-10-24T15:04:00Z", days: 14, expect: "Saturday, November 7, 2026 at 3:04 PM UTC" },
    { label: "month end Jan 31 + 30 → Mar 2 (non-leap)", issued: "2026-01-31T23:30:00Z", days: 30, expect: "Monday, March 2, 2026 at 11:30 PM UTC" },
    { label: "year end Dec 31 + 1", issued: "2026-12-31T00:00:00Z", days: 1, expect: "Friday, January 1, 2027 at 12:00 AM UTC" },
    { label: "leap day 2028-02-28 + 1", issued: "2028-02-28T12:00:00Z", days: 1, expect: "Tuesday, February 29, 2028 at 12:00 PM UTC" },
  ];
  for (const c of cases) {
    const issued = new Date(c.issued);
    const expires = new Date(issued.getTime() + c.days * DAY);
    check(`${c.label}: ${c.days} whole days`, wholeDaysBetween(issued, expires) === c.days, wholeDaysBetween(issued, expires));
    check(`${c.label}: "${c.expect}"`, formatUtcDateTimeLabelled(expires) === c.expect, formatUtcDateTimeLabelled(expires));
  }
  check("a partial day is floored (6d 23h → 6)", wholeDaysBetween(new Date(0), new Date(7 * DAY - 3600_000)) === 6);
  const T0 = new Date("2026-10-31T15:04:00Z").getTime();
  const span = (ms: number) => wholeDaysBetween(new Date(T0), new Date(T0 + ms));
  check("7d − 3 ms → 7 (clock skew between issue and expiry)", span(7 * DAY - 3) === 7, span(7 * DAY - 3));
  check("7d + 3 ms → 7", span(7 * DAY + 3) === 7, span(7 * DAY + 3));
  check("7d − 59 s → 7 (inside the 1-minute tolerance)", span(7 * DAY - 59_000) === 7, span(7 * DAY - 59_000));
  check("7d − 61 s → 6 (outside the tolerance: floored)", span(7 * DAY - 61_000) === 6, span(7 * DAY - 61_000));
  check("6.5d → 6", span(6.5 * DAY) === 6, span(6.5 * DAY));
  check("1d − 3 ms → 1", span(DAY - 3) === 1, span(DAY - 3));
  check("30 s → 0 (never rounds up to a first day)", span(30_000) === 0, span(30_000));
  check("non-positive span → 0", wholeDaysBetween(new Date(DAY), new Date(0)) === 0);
  check("daysPhrase singular / plural / zero", daysPhrase(1) === "1 day" && daysPhrase(3) === "3 days" && daysPhrase(0) === "less than a day");
  check("invalid date refuses to format", throws(() => formatUtcDateTimeLabelled(new Date("nope"))));
}

// ── 4. escaping ──────────────────────────────────────────────────────────────
console.log("4. escaping + URL validation");
{
  check("escapeHtml covers & < > \" '", escapeHtml(`&<>"'`) === "&amp;&lt;&gt;&quot;&#39;");
  check("safeHttpUrl refuses javascript:", throws(() => safeHttpUrl("javascript:alert(1)")));
  check("safeHttpUrl refuses data:", throws(() => safeHttpUrl("data:text/html,<b>x</b>")));
  check("safeHttpUrl refuses relative", throws(() => safeHttpUrl("/register?invite=x")));
  check("safeHttpUrl refuses credentials", throws(() => safeHttpUrl("https://u:p@example.test/")));
  check("cleanText strips CR/LF and U+2028", cleanText("Ann\r\nBcc: x\u2028y") === "Ann Bcc: x y", cleanText("Ann\r\nBcc: x\u2028y"));

  const issuedAt = new Date("2026-10-31T15:04:00Z");
  const expiresAt = new Date(issuedAt.getTime() + 7 * DAY);
  const evil = `<script>alert(1)</script>" onmouseover="x`;
  const r = renderBetaInvite({ origin: "request", recipientName: evil, inviteUrl: URL_OK, issuedAt, expiresAt }, { brand: BRAND });
  check("malicious name: no raw <script> in html", !r.html.includes("<script>"));
  check("malicious name: escaped form present", r.html.includes("&lt;script&gt;alert(1)&lt;/script&gt;&quot; onmouseover=&quot;x"));
  const nl = renderBetaInvite({ origin: "request", recipientName: "Eve\n\nClick http://evil.test", inviteUrl: URL_OK, issuedAt, expiresAt }, { brand: BRAND });
  check("name with line breaks cannot forge text lines", nl.text.includes("Hi Eve Click http://evil.test,") && !nl.text.includes("Eve\n"));

  check("javascript: invite URL is refused", throws(() => renderBetaInvite({ origin: "request", inviteUrl: "javascript:alert(1)", issuedAt, expiresAt }, { brand: BRAND })));
  const quoted = renderBetaInvite({ origin: "request", inviteUrl: `https://app.example.test/register?invite="><img src=x onerror=alert(1)>`, issuedAt, expiresAt }, { brand: BRAND });
  check("quote-breaking URL is percent-encoded in href", !quoted.html.includes("<img src=x") && quoted.html.includes("invite=%22%3E%3Cimg%20src=x"));
  check("expiresAt before issuedAt is refused", throws(() => renderBetaInvite({ origin: "request", inviteUrl: URL_OK, issuedAt: expiresAt, expiresAt: issuedAt }, { brand: BRAND })));
}

// ── 5. beta invite ───────────────────────────────────────────────────────────
console.log("5. beta approval invitation");
{
  const issuedAt = new Date("2026-10-24T15:04:00Z");
  const expiresAt = new Date(issuedAt.getTime() + 14 * DAY);
  const EXP = "Saturday, November 7, 2026 at 3:04 PM UTC";
  const r = renderBetaInvite({ origin: "request", recipientName: null, inviteUrl: URL_OK, issuedAt, expiresAt }, { brand: BRAND });

  check("subject", r.subject === BETA_INVITE_SUBJECT && r.subject === "Your Fourth Meridian beta access is approved");
  check("neutral greeting without a name", r.text.includes("\nHello,\n") && !r.text.includes("Hi "));
  check("greets by name when known", renderBetaInvite({ origin: "request", recipientName: "Sam", inviteUrl: URL_OK, issuedAt, expiresAt }, { brand: BRAND }).text.includes("Hi Sam,"));
  check("text: approval line", r.text.includes("Your Fourth Meridian beta access is approved."));
  check("text: computed validity", r.text.includes("You have 14 days to redeem your invitation."));
  check("text: labelled absolute expiry", r.text.includes(`It expires on ${EXP}.`));
  check("text: the CTA URL", r.text.includes(`Get Started:\n${URL_OK}`));
  check("text: ignore line", r.text.includes("If you didn't request access, you can ignore this email; the link expires on its own."));
  check("text: no HTML tags", !/<[a-z/][^>]*>/i.test(r.text));
  check("html: same expiry", r.html.includes(`It expires on ${EXP}.`) && r.html.includes("You have 14 days to redeem your invitation."));
  check("html: CTA href + visible fallback URL", r.html.split(`href="${URL_OK}"`).length - 1 === 2 && r.html.includes(`>${URL_OK}</a>`));
  check("html: CTA label", r.html.includes(">Get Started</a>"));
  {
    // Outlook (Word) ignores padding on <a>: the cell carries fill + mso-only padding;
    // other clients pad the inline-block link with the SAME value (identical look).
    const cell = r.html.match(/<td[^>]*class="fm-cta-cell"[^>]*>/)?.[0] ?? "";
    const link = r.html.match(/<td[^>]*class="fm-cta-cell"[^>]*><a [^>]*>/)?.[0]?.slice(cell.length) ?? "";
    check("CTA cell: bgcolor attribute + background-color style", cell.includes(`bgcolor="${LIGHT.ctaBg}"`) && cell.includes(`background-color:${LIGHT.ctaBg};`), cell);
    check("CTA cell: Outlook padding via mso-padding-alt:14px 32px", cell.includes("mso-padding-alt:14px 32px;"), cell);
    check("CTA cell: no standard padding (other clients would double it)", !/[;"]padding:/.test(cell), cell);
    check("CTA link: inline-block with the matching 14px 32px padding", link.includes("display:inline-block;padding:14px 32px;"), link);
  }
  check("html: logo alt text", r.html.includes(`alt="Fourth Meridian"`));
  check("html: logo is the hosted 128 px mark on the site origin", r.html.includes(`src="${BRAND.siteOrigin}/brand/fm-mark-dark-128.png"`));
  check("html: wordmark is real text", /<td[^>]*class="fm-heading"[^>]*>Fourth Meridian<\/td>/.test(r.html));

  for (const p of ["/privacy", "/terms", "/legal/ai"]) {
    check(`html: legal link ${p} on the site origin`, r.html.includes(`href="${BRAND.siteOrigin}${p}"`));
    check(`text: legal link ${p} on the site origin`, r.text.includes(`${BRAND.siteOrigin}${p}`));
  }
  check("footer: reason line", r.text.includes("You're receiving this email because a Fourth Meridian beta invitation was issued to this address."));
  check("footer: support contact", r.html.includes(`mailto:${BRAND.supportEmail}`) && r.text.includes(`Contact ${BRAND.supportEmail}.`));
  const noSupport = renderBetaInvite({ origin: "request", inviteUrl: URL_OK, issuedAt, expiresAt }, { brand: { ...BRAND, supportEmail: null } });
  check("footer: support line omitted when none is configured", !noSupport.html.includes("mailto:") && !noSupport.text.includes("Questions?"));

  // Validity is computed, never a constant.
  for (const days of [1, 3, 7, 9, 14, 30]) {
    const v = renderBetaInvite({ origin: "request", inviteUrl: URL_OK, issuedAt, expiresAt: new Date(issuedAt.getTime() + days * DAY) }, { brand: BRAND });
    const phrase = days === 1 ? "1 day" : `${days} days`;
    check(`${days}-day invite says "${phrase}" in both parts`, v.text.includes(`You have ${phrase} to redeem`) && v.html.includes(`You have ${phrase} to redeem`));
  }

  // Email-client structure.
  const tables = r.html.match(/<table\b[^>]*>/g) ?? [];
  check("every table is role=presentation", tables.length > 0 && tables.every((t) => t.includes(`role="presentation"`)), tables.filter((t) => !t.includes("presentation")));
  check("color-scheme meta tags", r.html.includes(`<meta name="color-scheme" content="light dark" />`) && r.html.includes(`<meta name="supported-color-schemes" content="light dark" />`));
  check("prefers-color-scheme: dark block", r.html.includes("@media (prefers-color-scheme: dark)") && r.html.includes(`.fm-card{background-color:${DARK.card} !important;}`));
  check("max-width 600 single column", r.html.includes("max-width:600px") && r.html.includes(`width="600"`));
  check("hidden preheader carries the expiry", /<div class="fm-preheader" style="display:none;[^"]*">Create your account within 14 days\. Your invitation expires Saturday/.test(r.html));
  check("no script tags anywhere", !/<script/i.test(r.html));
  const styles = r.html.match(/style="[^"]*"/g) ?? [];
  check("every inline style attribute is well-formed (no stray double quote ends it early)",
    styles.length > 20 && styles.every((st) => st.endsWith(';"')), styles.filter((st) => !st.endsWith(';"')).slice(0, 3));
  check("every opening tag's attributes parse (no attribute break-out)",
    (r.html.match(/<(a|td|table|p|img|div|h1|span|body)\b[^>]*>/g) ?? []).every((tag) => /^<\w+(\s+[\w:-]+(="[^"]*")?)*\s*\/?>$/.test(tag)));
  check("brass is an accent rule, never text colour", !new RegExp(`(^|[^-])color:${BRASS[500]}`).test(r.html) && r.html.includes(`background-color:${BRASS[500]}`));

  // The registry template uses the env-derived brand (Production site origin when unset).
  const viaRegistry = betaInviteTemplate.render({ origin: "request", inviteUrl: URL_OK, issuedAt, expiresAt });
  check("registry render returns html + text", typeof viaRegistry.html === "string" && viaRegistry.text.includes(URL_OK));
  check("registry render links legal pages on the site origin", viaRegistry.html!.includes(`href="${resolveEmailSiteOrigin()}/privacy"`));
}

// ── 5b. origin copy ──────────────────────────────────────────────────────────
console.log("5b. request vs direct invitation copy");
{
  const issuedAt = new Date("2026-10-31T15:04:00Z");
  const expiresAt = new Date(issuedAt.getTime() + 7 * DAY);
  const req = renderBetaInvite({ origin: "request", inviteUrl: URL_OK, issuedAt, expiresAt }, { brand: BRAND });
  const dir = renderBetaInvite({ origin: "direct", inviteUrl: URL_OK, issuedAt, expiresAt }, { brand: BRAND });
  check("request: subject", req.subject === "Your Fourth Meridian beta access is approved");
  check("request: heading + lead + ignore line (both parts)", ["Beta access approved", "Your Fourth Meridian beta access is approved.",
    "If you didn't request access, you can ignore this email; the link expires on its own."].every((l) => req.text.includes(l) && req.html.includes(escapeHtml(l))));
  check("direct: subject", dir.subject === "You're invited to the Fourth Meridian beta" && dir.subject === BETA_DIRECT_INVITE_SUBJECT);
  check("direct: heading + lead + guidance (both parts)", ["You're invited to the Fourth Meridian beta", "You've been invited to join the Fourth Meridian beta.",
    "If you weren't expecting this invitation, you can ignore this email; the link expires on its own."].every((l) => dir.text.includes(l) && dir.html.includes(escapeHtml(l))));
  check("direct: never claims a request or an approval", !/request(ed)? access|approved/i.test(dir.text) && !/approved/i.test(dir.html), dir.text);
  check("direct: shares expiry + CTA + next steps", dir.text.includes("You have 7 days to redeem your invitation.") && dir.text.includes(`Get Started:\n${URL_OK}`) && dir.text.includes("What happens next"));
}

// ── 6. security variant ──────────────────────────────────────────────────────
console.log("6. security variant");
{
  const s = renderSecurityEmail({
    subject: "Security notice", preheader: "p", heading: "Your password was changed",
    notice: "If this wasn't you, reset your password now.", reason: "You're receiving this because of a change to your account.",
    action: { label: "Reset password", url: "https://app.example.test/forgot-password" }, brand: BRAND,
  });
  check("renders the notice in both parts", s.text.includes("If this wasn't you") && s.html.includes("If this wasn&#39;t you"));
  check("refuses an info panel", throws(() => renderEmail({ subject: "s", preheader: "p", footer: { reason: "r" }, brand: BRAND, variant: "security",
    blocks: [{ kind: "security", text: "x" }, { kind: "info", items: ["promo"] }] })));
  check("requires a security block", throws(() => renderEmail({ subject: "s", preheader: "p", footer: { reason: "r" }, brand: BRAND, variant: "security",
    blocks: [{ kind: "paragraph", text: "x" }] })));
}

console.log(failures === 0 ? "\nAll email design checks passed." : `\n${failures} failure(s).`);
process.exit(failures === 0 ? 0 : 1);
