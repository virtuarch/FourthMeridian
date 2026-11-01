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
  AUTOMATION_ACTION_SEAMS, CODE_DEFAULT_VERSION_ID, COMMS_BASE, DEFAULT_DELIVERY_FILTERS, EMPTY_CATALOG_FILTERS,
  aiSuggestUrl, automationRunsUrl, automationUrl, automationsUrl, catalogDetailUrl, catalogTotalsUrl, catalogUrl, classifyCommsResponse, commsRead, commsWrite,
  deliveryUrl, preferencesUrl, previewUrl, publishUrl, queryString, renderUrl, rollbackUrl, saveDraftUrl, triggersUrl, versionUrl, versionsUrl, type FetchLike,
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
    const forbidden = classifyCommsResponse(403, { error: "Forbidden.", code: "FORBIDDEN" });
    check("403 FORBIDDEN ⇒ denied (code kept, server message shown)", forbidden.kind === "denied" && forbidden.code === "FORBIDDEN" && forbidden.error === "Forbidden.");
    const e500 = classifyCommsResponse(500, null);
    check("500 ⇒ error (not coming soon, not unavailable)", e500.kind === "error" && e500.status === 500 && e500.error === "Request failed (500).");
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
    check("chip totals: the same filters WITHOUT status, one row",
      catalogTotalsUrl({ status: "ENABLED", category: "SPACES", audience: null, channel: "EMAIL", consentClass: null, q: "x" })
        === `${COMMS_BASE}/catalog?category=SPACES&channel=EMAIL&q=x&limit=1`);
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

  console.log("4. content (v1.1 B1): URL builders");
  {
    const K = `${COMMS_BASE}/catalog/SYNC_FAILED`;
    check("versions: channel, variant, limit, cursor in a stable order", versionsUrl("SYNC_FAILED", "EMAIL", "sync-failed") === `${K}/versions?channel=EMAIL&variant=sync-failed&limit=50`
      && versionsUrl("SYNC_FAILED", "IN_APP", "default", "abc") === `${K}/versions?channel=IN_APP&variant=default&limit=50&cursor=abc`);
    check("versions: channel omitted when null (the server resolves the only leg / the lock)", versionsUrl("X", null, null) === `${COMMS_BASE}/catalog/X/versions?limit=50`);
    check("version detail and its writes are path-encoded", versionUrl("A/B", "v 1") === `${COMMS_BASE}/catalog/A%2FB/versions/v%201`
      && publishUrl("K", "v1") === `${COMMS_BASE}/catalog/K/versions/v1/publish` && rollbackUrl("K", CODE_DEFAULT_VERSION_ID) === `${COMMS_BASE}/catalog/K/versions/code-default/rollback`
      && aiSuggestUrl("K", "v1") === `${COMMS_BASE}/catalog/K/versions/v1/ai-suggest`);
    check("draft save posts to the versions collection; render to /render", saveDraftUrl("K") === `${COMMS_BASE}/catalog/K/versions` && renderUrl("K") === `${COMMS_BASE}/catalog/K/render`);
    check("preview ?versionId= (v1.1 §3.7) rides after channel / variant; absent by default",
      previewUrl("K", "email-html", null, "v9") === `${COMMS_BASE}/catalog/K/preview?channel=email-html&versionId=v9`
        && previewUrl("K", "in-app", "reauth-required") === `${COMMS_BASE}/catalog/K/preview?channel=in-app&variant=reauth-required`);
  }

  console.log("5. content (v1.1 B1): the classifier's write cases");
  {
    const c = classifyCommsResponse(409, { error: "This content changed.", code: "CONFLICT", current: 7 });
    check("409 CONFLICT ⇒ error with the server's `current` token", c.kind === "error" && c.code === "CONFLICT" && c.current === 7);
    const c2 = classifyCommsResponse(409, { error: "x", code: "CONFLICT", current: "7" });
    check("a non-integer `current` is dropped (never guessed)", c2.kind === "error" && c2.current === undefined);
    const prot = classifyCommsResponse(409, { error: "This message is protected: its content cannot be edited.", code: "PROTECTED", current: 3 });
    check("409 PROTECTED keeps its code; `current` only for CONFLICT", prot.kind === "error" && prot.code === "PROTECTED" && prot.current === undefined);
    const issue = { code: "FIELD_TOO_LONG", severity: "error", location: { field: "subject" }, message: "At most 120 characters." };
    const inv = classifyCommsResponse(400, { error: "Content is invalid.", code: "CONTENT_INVALID", issues: [issue, { junk: true }, null] });
    check("400 CONTENT_INVALID ⇒ the typed issues (malformed entries dropped)", inv.kind === "error" && inv.code === "CONTENT_INVALID" && inv.issues?.length === 1 && inv.issues[0].code === "FIELD_TOO_LONG");
    const v = classifyCommsResponse(400, { error: "expectedRevision must be a non-negative integer.", code: "VALIDATION" });
    check("400 VALIDATION without issues ⇒ no issues field", v.kind === "error" && v.issues === undefined);
    const rej = classifyCommsResponse(422, { error: "x", code: "SUGGESTION_REJECTED", suggestionId: "s1", issues: [issue] });
    check("422 SUGGESTION_REJECTED ⇒ error with issues", rej.kind === "error" && rej.status === 422 && rej.issues?.length === 1);
    const warn = classifyCommsResponse(409, { error: "x", code: "WARNINGS_UNACKNOWLEDGED", issues: [{ ...issue, severity: "warning", code: "FINANCIAL_CLAIM" }] });
    check("409 WARNINGS_UNACKNOWLEDGED ⇒ its warnings", warn.kind === "error" && warn.issues?.[0].severity === "warning");
    const ai = classifyCommsResponse(503, { error: "AI assistance is unavailable right now.", code: "AI_UNAVAILABLE", reason: "ALLOWANCE", detail: "EXHAUSTED", retryAfterSeconds: 3600 });
    check("503 AI_UNAVAILABLE ⇒ unavailable with the typed reason / detail / retry", ai.kind === "unavailable" && ai.code === "AI_UNAVAILABLE" && ai.ai?.reason === "ALLOWANCE" && ai.ai.detail === "EXHAUSTED" && ai.ai.retryAfterSeconds === 3600);
    const aiBad = classifyCommsResponse(503, { error: "x", code: "AI_UNAVAILABLE", reason: "SOMETHING" });
    check("an unknown AI reason is not trusted", aiBad.kind === "unavailable" && aiBad.ai === undefined);
    const plain503 = classifyCommsResponse(503, { error: "The notification content is unavailable.", code: "UNAVAILABLE" });
    check("a plain 503 has no ai block", plain503.kind === "unavailable" && plain503.ai === undefined);
  }

  console.log("6. commsWrite — same-origin JSON POST, never throws");
  {
    let seen: Parameters<FetchLike>[1] | undefined;
    let seenUrl = "";
    const f: FetchLike = async (u, init) => { seen = init; seenUrl = u; return { status: 201, json: async () => ({ success: true, result: { id: "v1" } }) }; };
    const r = await commsWrite<{ success: true; result: { id: string } }>("/w", { expectedRevision: 0, body: { channel: "EMAIL" } }, { fetchImpl: f });
    check("201 ⇒ ok with the envelope", r.kind === "ok" && r.data.result.id === "v1");
    check("POST, same-origin, JSON content type, the body serialised as-is", seenUrl === "/w" && seen?.method === "POST" && seen.credentials === "same-origin"
      && seen.headers?.["Content-Type"] === "application/json" && seen.body === JSON.stringify({ expectedRevision: 0, body: { channel: "EMAIL" } }));
    const conflict: FetchLike = async () => ({ status: 409, json: async () => ({ error: "Stale.", code: "CONFLICT", current: 4 }) });
    const c = await commsWrite("/w", {}, { fetchImpl: conflict });
    check("409 CONFLICT through commsWrite carries current", c.kind === "error" && c.current === 4);
    const totp: FetchLike = async () => ({ status: 403, json: async () => ({ error: "Two-factor…", code: "OPERATOR_TOTP_REQUIRED" }) });
    const t = await commsWrite("/w", {}, { fetchImpl: totp });
    check("403 OPERATOR_TOTP_REQUIRED ⇒ the house denied copy", t.kind === "denied" && /Two-factor verification/.test(t.error));
    const html: FetchLike = async () => ({ status: 500, json: async () => { throw new SyntaxError("<"); } });
    check("non-JSON error body ⇒ error, not a throw", (await commsWrite("/w", {}, { fetchImpl: html })).kind === "error");
    const down: FetchLike = async () => { throw new TypeError("Failed to fetch"); };
    const d = await commsWrite("/w", {}, { fetchImpl: down });
    check("network failure ⇒ status 0 error, never throws", d.kind === "error" && d.status === 0);
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    const cy = await commsWrite("/w", cyclic, { fetchImpl: f });
    check("an unserialisable body ⇒ error before any request", cy.kind === "error" && cy.status === 0);
  }

  console.log("7. mutation seams and source rules");
  {
    check("five seams: activate · pause · disable · dry-run · test-send", AUTOMATION_ACTION_SEAMS.map((s) => s.action).join() === "activate,pause,disable,dry-run,test-send");
    check("only activation is elevated (O-1: increasing reach); pause / disable stay ordinary", AUTOMATION_ACTION_SEAMS.filter((s) => s.elevated).map((s) => s.action).join() === "activate");
    check("seam paths follow the contract", AUTOMATION_ACTION_SEAMS[0].path("a1") === `${COMMS_BASE}/automations/a1/activate` && AUTOMATION_ACTION_SEAMS[4].path("a1") === `${COMMS_BASE}/test-send`);
    const src = strip("lib/platform/comms-center/client.ts");
    check("the ONLY mutation is commsWrite's POST (B1 content); no PATCH / DELETE; automation seams stay unwired",
      (src.match(/"POST"/g) ?? []).length === 2 && /method\?:\s*"POST"/.test(src) && /method:\s*"POST"/.test(src) && !/"PATCH"|"DELETE"/.test(src)
        && (src.match(/method\s*:/g) ?? []).length === 1);
    check("the client imports no server module (types + closed lists only)",
      [...src.matchAll(/^import\s+(type\s+)?[^;]*from\s+"([^"]+)"/gm)].every((m) => m[1] === "type " || m[2] === "./contract-v1-section-4"));
    check("Session 1's backend is imported for TYPES only", !/^import\s+\{[^}]*\}\s+from\s+"@\/lib\/notifications/m.test(src)
      && !/^import\s+\{[^}]*\}\s+from\s+"@\/lib\/notifications\/catalog\/(http|definitions|preview|read-deps)"/m.test(strip("lib/platform/comms-center/contract-v1-section-4.ts")));
    const contract = strip("lib/platform/comms-center/contract-v1-section-4.ts");
    check("§3.3 / §4.11 types are the SERVER's (re-exported from catalog/types), never a local copy",
      /export\s+type\s+\{[^}]*\bDeliveryAnalytics\b[^}]*\bDeliveryStatus\b[^}]*\bSuppressionReason\b[^}]*\}\s+from\s+"@\/lib\/notifications\/catalog\/types"/.test(contract)
        && /export\s+\{\s*DELIVERY_STATUSES,\s*SUPPRESSION_REASONS\s*\}\s+from\s+"@\/lib\/notifications\/catalog\/types"/.test(contract)
        && !/export\s+(type|interface)\s+(DeliveryStatus|SuppressionReason|DeliveryAnalytics|StatusCounts|ReasonCounts|DeliveryWindow|Aggregate)\b/.test(contract)
        && !/export\s+const\s+(DELIVERY_STATUSES|SUPPRESSION_REASONS)\b/.test(contract));
  }

  if (failures > 0) { console.error(`\ncomms-center client.test: ${failures} failure(s).`); process.exit(1); }
  console.log("\ncomms-center client.test: all passed.");
}

void main();
