/**
 * lib/platform/comms-center/client.test.ts  (Comms Center UI — Session 2)
 *
 * The route-probe rule ("not yet available" vs real data vs honest outage) and
 * the URL builders the four Communications views read through.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/platform/comms-center/client.test.ts
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import {
  AUTOMATION_ACTION_SEAMS, COMMS_BASE, DEFAULT_DELIVERY_FILTERS, EMPTY_CATALOG_FILTERS,
  automationRunsUrl, automationUrl, automationsUrl, catalogDetailUrl, catalogUrl, classifyCommsResponse, commsRead,
  deliveryUrl, preferencesUrl, previewUrl, queryString, triggersUrl, type FetchLike,
} from "./client";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`); }
}
const strip = (rel: string) => readFileSync(path.join(process.cwd(), rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

async function main() {
  console.log("1. route probe — not yet available vs data vs outage");
  {
    check("404 without a contract body (no route deployed) ⇒ coming soon", classifyCommsResponse(404, null).kind === "coming-soon");
    check("404 with an unrelated body ⇒ coming soon", classifyCommsResponse(404, { message: "not here" }).kind === "coming-soon");
    check("501 ⇒ coming soon", classifyCommsResponse(501, { error: "Not implemented" }).kind === "coming-soon");
    const nf = classifyCommsResponse(404, { error: "No catalog definition has that key.", code: "NOT_FOUND" });
    check("404 with the contract's NOT_FOUND code ⇒ a real not-found (not coming soon)", nf.kind === "not-found" && nf.error === "No catalog definition has that key.");
    const ok = classifyCommsResponse<{ items: number[] }>(200, { items: [1] });
    check("200 ⇒ the real data", ok.kind === "ok" && ok.data.items[0] === 1);
    check("503 UNAVAILABLE ⇒ unavailable (never empty data)", classifyCommsResponse(503, { error: "x", code: "UNAVAILABLE" }).kind === "unavailable");
    const totp = classifyCommsResponse(403, { error: "Forbidden.", code: "OPERATOR_TOTP_REQUIRED" });
    check("403 OPERATOR_TOTP_REQUIRED ⇒ denied with a two-factor message", totp.kind === "denied" && /Two-factor/.test(totp.error) && totp.code === "OPERATOR_TOTP_REQUIRED");
    check("401 ⇒ denied", classifyCommsResponse(401, { error: "Authentication required.", code: "UNAUTHENTICATED" }).kind === "denied");
    check("429 ⇒ rate limited", classifyCommsResponse(429, { error: "slow", code: "RATE_LIMITED" }).kind === "rate-limited");
    const inv = classifyCommsResponse(409, { error: "This definition has no banner rendition.", code: "INVALID_STATE" });
    check("409 INVALID_STATE keeps its code (the preview's 'no such channel')", inv.kind === "error" && inv.code === "INVALID_STATE");
    const bad = classifyCommsResponse(400, { error: "x".repeat(500), code: "lower-case not a code" });
    check("error text is capped and a malformed code is dropped", bad.kind === "error" && bad.error.length === 200 && bad.code === null);
  }

  console.log("2. commsRead — injected fetch, HTML 404, network failure");
  {
    const html404: FetchLike = async () => ({ status: 404, json: async () => { throw new SyntaxError("Unexpected token <"); } });
    check("a missing route answering HTML 404 ⇒ coming soon", (await commsRead("/x", { fetchImpl: html404 })).kind === "coming-soon");
    let seen: unknown = null;
    const okFetch: FetchLike = async (_u, init) => { seen = init?.credentials; return { status: 200, json: async () => ({ population: 3 }) }; };
    const r = await commsRead<{ population: number }>("/x", { fetchImpl: okFetch });
    check("200 JSON ⇒ ok with data; same-origin credentials", r.kind === "ok" && r.data.population === 3 && seen === "same-origin");
    const down: FetchLike = async () => { throw new TypeError("Failed to fetch"); };
    const net = await commsRead("/x", { fetchImpl: down });
    check("network failure ⇒ error (status 0), never throws", net.kind === "error" && net.status === 0);
    const u503: FetchLike = async () => ({ status: 503, json: async () => ({ error: "The notification catalog is unavailable.", code: "UNAVAILABLE" }) });
    const un = await commsRead("/x", { fetchImpl: u503 });
    check("503 body ⇒ unavailable with the server's message", un.kind === "unavailable" && un.error === "The notification catalog is unavailable.");
  }

  console.log("3. URL builders (filters → query string)");
  {
    check("queryString skips null / empty values and keeps order", queryString([["a", "1"], ["b", null], ["c", ""], ["d", 2]]) === "?a=1&d=2" && queryString([["a", null]]) === "");
    check("empty catalog filters ⇒ limit=100 only", catalogUrl(EMPTY_CATALOG_FILTERS) === `${COMMS_BASE}/catalog?limit=100`);
    check("every server-side filter + q in a stable order",
      catalogUrl({ status: "ENABLED", category: "SPACES", audience: "ACCOUNT_HOLDER", channel: "EMAIL", consentClass: "AWARENESS", q: "  invite " })
        === `${COMMS_BASE}/catalog?status=ENABLED&category=SPACES&audience=ACCOUNT_HOLDER&channel=EMAIL&consentClass=AWARENESS&q=invite&limit=100`);
    check("q is URL-encoded; blank q is dropped", catalogUrl({ ...EMPTY_CATALOG_FILTERS, q: "a&b c" }).includes("q=a%26b+c") && !catalogUrl({ ...EMPTY_CATALOG_FILTERS, q: "   " }).includes("q="));
    check("a cursor rides last", catalogUrl(EMPTY_CATALOG_FILTERS, "abc_-") === `${COMMS_BASE}/catalog?limit=100&cursor=abc_-`);
    check("detail key is path-encoded", catalogDetailUrl("A/B") === `${COMMS_BASE}/catalog/A%2FB`);
    check("preview: channel always, variant only when chosen",
      previewUrl("SYNC_FAILED", "in-app", null) === `${COMMS_BASE}/catalog/SYNC_FAILED/preview?channel=in-app`
        && previewUrl("SYNC_FAILED", "email-html", "legacy-no-state") === `${COMMS_BASE}/catalog/SYNC_FAILED/preview?channel=email-html&variant=legacy-no-state`);
    check("triggers read the whole catalog", triggersUrl() === `${COMMS_BASE}/triggers?limit=100`);
    check("automations / detail / runs", automationsUrl() === `${COMMS_BASE}/automations?limit=50` && automationsUrl("PAUSED") === `${COMMS_BASE}/automations?state=PAUSED&limit=50`
      && automationUrl("a1") === `${COMMS_BASE}/automations/a1` && automationRunsUrl("a1") === `${COMMS_BASE}/automations/a1/runs?limit=20`);
    check("delivery: default window 7d; filters appended",
      deliveryUrl(DEFAULT_DELIVERY_FILTERS) === `${COMMS_BASE}/delivery?window=7d`
        && deliveryUrl({ window: "30d", channel: "EMAIL", status: "CAPTURED", template: null }) === `${COMMS_BASE}/delivery?window=30d&channel=EMAIL&status=CAPTURED`);
    check("preferences", preferencesUrl() === `${COMMS_BASE}/preferences`);
    check("base path is the contract's", COMMS_BASE === "/api/platform/customer-success/notifications");
  }

  console.log("4. mutation seams — declared, never wired");
  {
    check("five seams: activate · pause · disable · dry-run · test-send", AUTOMATION_ACTION_SEAMS.map((s) => s.action).join() === "activate,pause,disable,dry-run,test-send");
    check("only activation is elevated (O-1: increasing reach); pause / disable stay ordinary", AUTOMATION_ACTION_SEAMS.filter((s) => s.elevated).map((s) => s.action).join() === "activate");
    check("seam paths follow the contract", AUTOMATION_ACTION_SEAMS[0].path("a1") === `${COMMS_BASE}/automations/a1/activate` && AUTOMATION_ACTION_SEAMS[4].path("a1") === `${COMMS_BASE}/test-send`);
    const src = strip("lib/platform/comms-center/client.ts");
    check("the client sends no mutation (no POST / PATCH / method:)", !/method\s*:|"POST"|"PATCH"|"DELETE"/.test(src));
    check("the client imports no server module (types + closed lists only)",
      [...src.matchAll(/^import\s+(type\s+)?[^;]*from\s+"([^"]+)"/gm)].every((m) => m[1] === "type " || m[2] === "./contract-v1-section-4"));
    check("Session 1's backend is imported for TYPES only", !/^import\s+\{[^}]*\}\s+from\s+"@\/lib\/notifications/m.test(src)
      && !/^import\s+\{[^}]*\}\s+from\s+"@\/lib\/notifications\/catalog\/(http|definitions|preview|read-deps)"/m.test(strip("lib/platform/comms-center/contract-v1-section-4.ts")));
  }

  if (failures > 0) { console.error(`\ncomms-center client.test: ${failures} failure(s).`); process.exit(1); }
  console.log("\ncomms-center client.test: all passed.");
}

void main();
