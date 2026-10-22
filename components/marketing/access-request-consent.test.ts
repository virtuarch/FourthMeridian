/**
 * components/marketing/access-request-consent.test.ts — PRIV-012 (notice +
 * consent): the beta waitlist shows a privacy notice and requires consent, and
 * the server refuses a submission without it.
 *
 * PART A — render the REAL RequestAccessForm (react-dom/server): notice,
 *          Privacy Policy link, required unchecked consent checkbox.
 * PART B — call the REAL POST /api/access-request handler with the DB faked
 *          (never connected): no consent ⇒ 400 and NOTHING written; consent ⇒
 *          200 and the audit row records the notice version.
 *
 *     npx tsx --require ./scripts/lib/server-only-preload.cjs components/marketing/access-request-consent.test.ts
 */

process.env.DATABASE_URL ??= "postgresql://none:none@127.0.0.1:1/none"; // never connected: the client is faked below

import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RequestAccessForm } from "@/components/marketing/RequestAccessForm";
import {
  ACCESS_REQUEST_CONSENT_LABEL,
  ACCESS_REQUEST_NOTICE,
  ACCESS_REQUEST_NOTICE_VERSION,
  CONSENT_REQUIRED_ERROR,
} from "@/components/marketing/access-request-consent";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const unescape = (s: string) => s.replace(/&#x27;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

async function main() {
  console.log("access-request notice + consent (PRIV-012)\n\nA. the form");
  const html = unescape(renderToStaticMarkup(h(RequestAccessForm)));
  check("the privacy notice is shown", html.includes(ACCESS_REQUEST_NOTICE) && html.includes("data-privacy-notice"));
  check("it links the Privacy Policy", /<a [^>]*href="\/privacy"[^>]*>Privacy Policy<\/a>/.test(html));
  check("a consent checkbox is present, required, and NOT pre-ticked",
    /<input[^>]*id="access-consent"[^>]*>/.test(html) &&
    /<input[^>]*type="checkbox"[^>]*required=""/.test(html) &&
    !/<input[^>]*id="access-consent"[^>]*checked=""/.test(html), html.match(/<input[^>]*access-consent[^>]*>/)?.[0]);
  check("the checkbox is labelled with the consent text", html.includes(ACCESS_REQUEST_CONSENT_LABEL) && /<label[^>]*for="access-consent"/.test(html));
  check("the notice precedes the submit button", html.indexOf(ACCESS_REQUEST_NOTICE) < html.indexOf('type="submit"'));

  console.log("\nB. the route");
  const writes: string[] = [];
  const auditRows: Array<{ metadata?: Record<string, unknown> }> = [];
  const { db } = await import("@/lib/db");
  Object.defineProperty(db, "betaAccessRequest", { value: { async createMany() { writes.push("betaAccessRequest"); return { count: 1 }; } }, configurable: true });
  Object.defineProperty(db, "betaAccessRequestEvent", { value: { async create() { writes.push("betaAccessRequestEvent"); return {}; } }, configurable: true });
  Object.defineProperty(db, "auditLog", { value: { async create(a: { data: { metadata?: Record<string, unknown> } }) { writes.push("auditLog"); auditRows.push(a.data); return {}; } }, configurable: true });
  const { POST } = await import("@/app/api/access-request/route");
  const post = (body: unknown) => POST(new Request("https://app.fourthmeridian.com/api/access-request", {
    method: "POST", headers: { "content-type": "application/json", "x-real-ip": "203.0.113.9" }, body: JSON.stringify(body),
  }) as never);

  for (const [label, consent] of [["absent", undefined], ["false", false], ['the string "true"', "true"], ["1", 1]] as const) {
    writes.length = 0;
    const res = await post({ email: "person@example.com", ...(consent === undefined ? {} : { consent }) });
    const body = await res.json();
    check(`consent ${label} → 400 with the consent error`, res.status === 400 && body.error === CONSENT_REQUIRED_ERROR, `${res.status} ${JSON.stringify(body)}`);
    check(`…and nothing was written (consent ${label})`, writes.length === 0, writes.join(","));
  }
  writes.length = 0; auditRows.length = 0;
  const ok = await post({ email: "person@example.com", consent: true });
  check("consent: true → 200", ok.status === 200, String(ok.status));
  check("…the request, the event and the audit row are written", writes.join(",") === "betaAccessRequest,betaAccessRequestEvent,auditLog", writes.join(","));
  check("…the audit row records the notice version consented to, and no raw email",
    auditRows[0]?.metadata?.consentNoticeVersion === ACCESS_REQUEST_NOTICE_VERSION && !JSON.stringify(auditRows[0]).includes("person@example.com"),
    JSON.stringify(auditRows[0]));

  if (failures > 0) { console.error(`\naccess-request consent: ${failures} check(s) failed.`); process.exit(1); }
  console.log("\naccess-request consent: all checks passed.");
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
