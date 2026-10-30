/**
 * components/platform/widgets/provider-health.test.ts  (UX-P1 · Agent 3)
 *
 * The provider table's view-model and surface, DB-free:
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs components/platform/widgets/provider-health.test.ts
 *
 * Pinned: the trust tone map is the provider authority's own vocabulary; Resend
 * is a separately-labelled delivery authority that emits counts and no
 * verdict; OpenAI is Unavailable because no PLATFORM_OPS route exposes an AI
 * provider authority; a failed provider-health read leaves rows that say so
 * rather than vanishing; thresholds and affected lists are never inferred from
 * prose; the widget's first frame is the loading state.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { ProviderHealth } from "@/lib/platform/provider-health";
import type { ProviderHealthResponse } from "@/app/api/platform/platform-ops/provider-health/route";
import type { EmailHealthResponse } from "@/app/api/platform/platform-ops/email-health/route";
import { NO_AUTHORITY } from "../platform-surface";
import {
  AFFECTED_NOT_LISTED, OPENAI_NO_AUTHORITY, RESEND_AUTHORITY, RESEND_NO_VERDICT, THRESHOLD_NOT_EMITTED, TRUST_TONE, TRUST_WORD,
  isUnavailable, providerRows, trustSegments,
} from "./provider-view";
import { OpsProviderHealthWidget, ProviderHealthSurface, ProviderRowDetail } from "./OpsProviderHealthWidget";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const ROOT = process.cwd();
const strip = (rel: string) =>
  readFileSync(path.join(ROOT, rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

const NOW = Date.parse("2026-10-14T12:00:00.000Z");

function provider(over: Partial<ProviderHealth>): ProviderHealth {
  return {
    key: "PLAID", label: "Plaid", kind: "BANKING", trust: "OPERATIONAL",
    availability: 0.98, lastSuccessAt: "2026-10-14T10:00:00.000Z", lastFailureAt: null, latencyMs: 1800,
    quota: null, remainingQuota: null, coverage: null, coverageUnit: null,
    freshness: { state: "fresh", asOf: null, ageDays: null, source: "connection-health", detail: "all connections healthy" },
    syncFailures: 0, errorRate: 0.02, callsToday: 12, calls30d: 300, notes: ["Plaid exposes no pollable quota/billing API — quota is not reportable."],
    ...over,
  };
}
const providersOk: ProviderHealthResponse = {
  checkedAt: "2026-10-14T11:59:00.000Z",
  counts: { OPERATIONAL: 1, DEGRADED: 0, STALE: 1, FAILING: 0, UNKNOWN: 0 },
  providers: [
    provider({}),
    provider({ key: "OPEN_EXCHANGE_RATES", label: "Open Exchange Rates", kind: "FX", trust: "STALE", lastSuccessAt: null,
      freshness: { state: "stale", asOf: "2026-10-10", ageDays: 4, source: "resource-freshness", detail: "newest observation is 4d old" }, coverage: 160, coverageUnit: "currency pairs" }),
  ],
};
const emailOk: EmailHealthResponse = { windowDays: 7, counts: { sent: 40, captured: 2, error: 1, skipped: 3, total: 46 }, recentErrors: [] };
const ok = <T,>(data: T) => ({ data, loading: false, error: null });
const failed = { data: null, loading: false, error: "Request failed (500)" };
const pending = { data: null, loading: true, error: null };

console.log("1. trust tone map is the provider authority's vocabulary");
{
  check("OPERATIONAL ok", TRUST_TONE.OPERATIONAL === "ok");
  check("DEGRADED warn", TRUST_TONE.DEGRADED === "warn");
  check("STALE warn", TRUST_TONE.STALE === "warn");
  check("FAILING bad", TRUST_TONE.FAILING === "bad");
  check("UNKNOWN muted", TRUST_TONE.UNKNOWN === "muted");
  check("every trust has a word", (Object.keys(TRUST_TONE) as (keyof typeof TRUST_WORD)[]).every((k) => TRUST_WORD[k].length > 0));
  check("segments follow the authority's counts", trustSegments(providersOk.counts).map((s) => `${s.word}:${s.count}`).join(",") === "Operational:1,Degraded:0,Stale data:1,Failing:0,Unknown:0");
}

console.log("2. rows — one per authority, never merged, never invented");
{
  const rows = providerRows(ok(providersOk), ok(emailOk));
  check("four rows: Plaid, OXR, Resend, OpenAI", rows.map((r) => r.key).join() === "PLAID,OPEN_EXCHANGE_RATES,RESEND,OPENAI");
  const plaid = rows[0], oxr = rows[1], resend = rows[2], openai = rows[3];
  check("Plaid status is its trust word + tone", "word" in plaid.status && plaid.status.word === "Operational" && plaid.status.tone === "ok");
  check("OXR status Stale data / warn", "word" in oxr.status && oxr.status.word === "Stale data" && oxr.status.tone === "warn");
  check("freshness is the authority's state word with its detail", !isUnavailable(oxr.freshness) && oxr.freshness.value === "Stale" && oxr.freshness.qualifier === "newest observation is 4d old");
  check("last success is the ISO when present, a reason when absent", "iso" in plaid.lastSuccess && "unavailable" in oxr.lastSuccess);
  check("threshold is not emitted ⇒ Unavailable with that reason", isUnavailable(plaid.threshold) && plaid.threshold.unavailable === THRESHOLD_NOT_EMITTED);
  check("affected connections are not listed ⇒ 'not listed' (never parsed from prose)", isUnavailable(plaid.affected) && plaid.affected.unavailable === AFFECTED_NOT_LISTED);
  // PLATFORM OPS PHASE 1 UX — re-ruled: Pipeline and Jobs are VIEWS of Operations now.
  check("Plaid's doorway is Pipeline; OXR's is Jobs", "workspaceId" in plaid.action && plaid.action.workspaceId === "platform-overview:pipeline" && "workspaceId" in oxr.action && oxr.action.workspaceId === "platform-overview:jobs");
  check("provider rows carry the detail record for the drawer", plaid.detail?.key === "PLAID");

  check("Resend is labelled by its own authority", resend.authority === RESEND_AUTHORITY);
  check("Resend status is explicitly 'counts, no verdict' (never a tone)", "unavailable" in resend.status && resend.status.unavailable === RESEND_NO_VERDICT);
  check("Resend freshness is the delivery counts in words", !isUnavailable(resend.freshness) && resend.freshness.value === "1 error · 2 captured · 40 sent" && (resend.freshness.qualifier ?? "").includes("46 deliveries in 7 d"));
  check("Resend has no doorway (its surface is composed on the same workspace)", "unavailable" in resend.action);
  check("Resend carries no drawer record", resend.detail === null);

  check("OpenAI has no authority", openai.authority === NO_AUTHORITY && "unavailable" in openai.status && openai.status.unavailable === OPENAI_NO_AUTHORITY);
  check("OpenAI's every cell is Unavailable", isUnavailable(openai.freshness) && isUnavailable(openai.threshold) && isUnavailable(openai.affected) && "unavailable" in openai.lastSuccess);
  check("OpenAI doorway goes to the AI workspace (a ledger, not a verdict)", "workspaceId" in openai.action && openai.action.workspaceId === "platform-ai");
}

console.log("3. a failed or pending read says so on each row — rows never vanish");
{
  const rows = providerRows(failed, failed);
  check("Plaid and OXR rows still exist", rows.map((r) => r.key).join() === "PLAID,OPEN_EXCHANGE_RATES,RESEND,OPENAI");
  check("their status names the failed read", "unavailable" in rows[0].status && rows[0].status.unavailable.includes("provider-health read failed"));
  check("Resend names its failed read", "unavailable" in rows[2].status && rows[2].status.unavailable.includes("email-health read failed"));
  const pend = providerRows(pending, pending);
  check("a pending read is 'pending', not failed and not a verdict", "unavailable" in pend[0].status && pend[0].status.unavailable.includes("pending") && "unavailable" in pend[2].status && pend[2].status.unavailable.includes("pending"));
}

console.log("4. the surface");
{
  const first = renderToStaticMarkup(createElement(OpsProviderHealthWidget, { section: { id: "s", key: "ops_provider_health", label: "Provider health" } }));
  check("first frame is the loading state", first.includes("Loading…") && first.includes("Provider health"));

  const html = renderToStaticMarkup(createElement(ProviderHealthSurface, { title: "Provider health", providers: ok(providersOk), email: ok(emailOk), onOpenWorkspace: () => {}, nowMs: NOW }));
  check("headings", ["Provider", "Status", "Data freshness", "Last success", "Threshold", "Affected connections", "Action"].every((h) => html.includes(`>${h}<`)));
  check("tone words render as text (never colour alone)", html.includes(">Operational<") && html.includes(">Stale data<"));
  check("Resend row names its authority and says no verdict", html.includes(RESEND_AUTHORITY) && html.includes(RESEND_NO_VERDICT));
  check("OpenAI row says no authority", html.includes(OPENAI_NO_AUTHORITY) && html.includes(NO_AUTHORITY));
  check("doorways name their workspaces", html.includes("Pipeline →") && html.includes("Jobs →") && html.includes("AI &amp; Costs →")); // P-10; Phase 1 UX relabel "AI & Costs" (escaped in markup)
  check("last success is relative over UTC", html.includes("2h 0m ago") && html.includes("14 Oct 10:00 UTC"));
  check("the trust bar is scoped to the provider-health authority", html.includes("provider-health authority only (2 providers)"));
  const noHost = renderToStaticMarkup(createElement(ProviderHealthSurface, { title: "Provider health", providers: ok(providersOk), email: ok(emailOk), nowMs: NOW }));
  check("without a host switcher the action cell says so instead of a dead link", noHost.includes("no workspace switcher on this host") && !noHost.includes("Pipeline →"));
  const detail = renderToStaticMarkup(createElement(ProviderRowDetail, { row: providerRows(ok(providersOk), ok(emailOk))[0], nowMs: NOW, onOpenWorkspace: () => {} }));
  check("below-md expansion carries the dropped columns", ["Last success", "Threshold", "Affected connections", "Action", THRESHOLD_NOT_EMITTED].every((s) => detail.includes(s)));
  const failedHtml = renderToStaticMarkup(createElement(ProviderHealthSurface, { title: "Provider health", providers: failed, email: ok(emailOk), nowMs: NOW }));
  check("a failed provider read is an alert AND the rows still render", failedHtml.includes('role="alert"') && failedHtml.includes("Resend") && failedHtml.includes("provider-health read failed"));
}

console.log("5. source pins");
{
  const widget = strip("components/platform/widgets/OpsProviderHealthWidget.tsx");
  const view = strip("components/platform/widgets/provider-view.ts");
  check("widget reads both routes through useWidgetFetch literals", /useWidgetFetch<ProviderHealthResponse>\("\/api\/platform\/platform-ops\/provider-health"\)/.test(widget) && /useWidgetFetch<EmailHealthResponse>\("\/api\/platform\/platform-ops\/email-health"\)/.test(widget));
  check("no raw fetch", !/[^d]fetch\(/.test(widget));
  check("no rgba / hex colour", !/rgba\(|#[0-9a-f]{3,6}\b/i.test(widget));
  check("no matchMedia; collapse by md: classes", !/matchMedia/.test(widget) && /hidden md:block/.test(widget) && /md:hidden/.test(widget));
  check("no truncation", !/truncate/.test(widget));
  check("the view derives no trust (no re-judgement of availability/errorRate)", !/availability\s*[<>]|errorRate\s*[<>]|consecutiveFailures/.test(view));
  check("the view never parses prose for a count", !/match\(|parseInt|parseFloat/.test(view));
  check("widget imports no server module", !/@\/lib\/db|@\/lib\/platform\/provider-health"(?!;)|customer-core"/.test(widget.replace(/import type[^;]+;/g, "")));
}

if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nall checks passed");
