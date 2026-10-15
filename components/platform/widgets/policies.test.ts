/**
 * components/platform/widgets/policies.test.ts  (PLATFORM OPS POLICIES — Slice 1 · 2 · P1 · UX-P1)
 *
 * THE POLICIES SURFACE, RENDERED — every state provable by handing the
 * presentational components props, and the read-only contract pinned. UX-P1
 * adds: the four-chip legend + Provenance chip per row, declared policy kept
 * apart from the observation line, the three declared job groups (Fixed
 * collapsed), the unified editor with a required reason (D7), and the copy fixes
 * (grace in the footnote, the retired "Nothing here … changes a policy" line,
 * no per-row explanatory sentence).
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs components/platform/widgets/policies.test.ts
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { SCHEDULED_JOBS } from "@/lib/jobs/registry";
import { schedulerCapability } from "@/lib/platform/scheduler-capability";
import { composeRefreshPoliciesReadModel, type ComposeRefreshPolicyInput } from "@/lib/platform/policies/refresh-policies.core";
import type { JobCadenceView } from "@/lib/platform/policies/job-cadence";
import { CostSafeguardsPanel, JobCadenceEditor, JobCadencePanel, PoliciesSurface, PolicyEditor } from "./OpsPoliciesWidget";
import type { AiSpendResponse } from "@/app/api/platform/platform-ops/ai-spend/route";
import {
  cadenceText, effectiveHeadline, groupJobCadences, jobLegend, jobProvenance, originText, policiesFootnote, refreshLegend, refreshProvenance,
  schedulerSupportText,
} from "./policies-view";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const NOW = new Date("2026-09-14T12:00:00.000Z");
const section = { id: "s1", key: "ops_policies", label: "Policies" };
const input = (kind: "BANK" | "WALLET", over: Partial<ComposeRefreshPolicyInput> = {}): ComposeRefreshPolicyInput => ({
  sourceKind: kind, label: kind === "BANK" ? "Bank refresh" : "Wallet refresh", description: "d", row: null, updatedByName: null,
  capability: schedulerCapability(kind, SCHEDULED_JOBS), evidence: null, ...over,
});
const render = (state: { data: unknown; loading: boolean; error: string | null }, canControl = false, extra: Record<string, unknown> = {}) =>
  renderToStaticMarkup(createElement(PoliciesSurface, { section, state: state as never, canControl, ...extra }));
const fmt = (iso: string) => iso.slice(0, 16).replace("T", " ") + " UTC";

const job = (over: Partial<JobCadenceView>): JobCadenceView => ({
  job: "fetch-fx-rates", hours: 24, origin: "DEFAULT", defaultHours: 24, minHours: 6, maxHours: 168, editable: true,
  settingKey: "job_cadence_hours_fetch-fx-rates", primary: null, note: "Default: every 24 hours.", updatedAt: null,
  lastStartedAt: "2026-09-14T06:30:00.000Z", lastStatus: "succeeded", nextDueAt: "2026-09-15T06:25:00.000Z", ...over,
});
const JOBS: JobCadenceView[] = [
  job({ job: "sync-banks", hours: 24, origin: "REFRESH_POLICY", editable: false, settingKey: "refresh_cadence_bank", minHours: 24, maxHours: 24, note: "Governed by the bank refresh policy." }),
  job({ job: "fetch-fx-rates" }),
  job({ job: "fetch-security-prices", hours: 12, origin: "SETTING", updatedAt: "2026-09-13T18:32:00.000Z", note: "Override: every 12 hours (allowed 6–168)." }),
  job({ job: "sync-crypto", hours: 6, origin: "REFRESH_POLICY", editable: false, settingKey: "refresh_cadence_wallet", defaultHours: 6, minHours: 6, maxHours: 6 }),
  job({ job: "sync-crypto-continuation", hours: 6, origin: "FOLLOWS_PRIMARY", editable: false, settingKey: null, primary: "sync-crypto", defaultHours: 6, minHours: 6, maxHours: 6, nextDueAt: null }),
  ...["process-deletions", "notification-cleanup", "notification-retry", "purge-trash", "rate-limit-sweep"].map((name) =>
    job({ job: name, hours: 24, origin: "FIXED", editable: false, settingKey: null, minHours: 24, maxHours: 24, lastStartedAt: null, lastStatus: null, nextDueAt: null })),
  job({ job: "evaluate-alerts", hours: 6, origin: "DEFAULT", defaultHours: 6, minHours: 1, maxHours: 168 }),
];
const cadenceState = { data: { checkedAt: NOW.toISOString(), wakeEveryMinutes: 15, jobs: JOBS }, loading: false, error: null };

console.log("1. the default picture (the real database today)");
{
  const model = composeRefreshPoliciesReadModel([input("BANK"), input("WALLET")], NOW);
  const html = render({ data: model, loading: false, error: null });
  check("both sources are visible", /Bank refresh/.test(html) && /Wallet refresh/.test(html));
  check("bank: Every 24 hours · overdue after 30 hours", /Every 24 hours/.test(html) && /overdue after 30 hours/.test(html));
  check("wallet: Every 6 hours · overdue after 8 hours", /Every 6 hours/.test(html) && /overdue after 8 hours/.test(html));
  check("origin reads as the platform default — ONCE per column, on the Provenance chip", (html.match(/Platform default/g) ?? []).length === 2);
  check("legend: bank Default 24 h · Override — · Floor 6 h · Max 24 h", /Default 24 h/.test(html) && /Floor 6 h/.test(html) && /Max 24 h/.test(html) && (html.match(/Override —/g) ?? []).length === 2);
  check("legend: wallet Default 6 h · Floor 4 h", /Default 6 h/.test(html) && /Floor 4 h/.test(html));
  check("scheduler support reads Supported for both (the word, not a reason)", (html.match(/>Supported</g) ?? []).length === 2 && !/>Not supported</.test(html));
  check("available cadences: wallet the whole menu, bank from 6h", /4h · 6h · 8h · 12h · 24h/.test(html) && /6h · 8h · 12h · 24h/.test(html));
  check("unsupported options carry their reasons (the bank floor)", /floor of 6 hours/.test(html));
  check("execution is stated as wake + floor, not UTC slots", /woken every 15 minutes/.test(html) && /floor 4 hours/.test(html) && !/00:00, 06:00/.test(html));
  check("the observation line: Latest sweep Unknown with its reason, never a fabricated verdict", /Latest sweep: /.test(html) && /Unknown/.test(html) && /unknown/.test(html));
  check("grace is stated once as the code-owned rule, in the footnote, not the header", /larger of 2 hours and 25%/.test(html) && (html.match(/larger of 2 hours/g) ?? []).length === 1 && !/<header[^>]*>[\s\S]*?larger of 2 hours/.test(html.split("</header>")[0] ?? ""));
  check("the retired sentence is gone", !/Nothing here/.test(html) && !/changes a policy/.test(html));
  check("no doorway without a switcher", !/Open Jobs/.test(html));
  const wired = render({ data: model, loading: false, error: null }, false, { onOpenWorkspace: () => {} });
  check("with a switcher the observation line carries a Jobs doorway (a button, no link)", (wired.match(/aria-label="Open Jobs"/g) ?? []).length === 2 && !/<a /.test(wired));
}

console.log("\n2. an invalid legacy override is never presented as configured");
{
  const model = composeRefreshPoliciesReadModel([input("BANK"), input("WALLET", { row: { value: "soon", updatedAt: NOW, updatedById: null } })], NOW);
  const html = render({ data: model, loading: false, error: null });
  check("headline says the DEFAULT is in force", /Default every 6 hours/.test(html));
  check("provenance says the stored override is invalid", /stored override is invalid/.test(html));
  check("legend names the unreadable value as the override", /Override soon \(invalid\)/.test(html));
  check("the mismatch message names the unreadable value", /unreadable/.test(html) && /soon/.test(html));
  check("it is not rendered as Every 6 hours configured", !/>Every 6 hours</.test(html));
}

console.log("\n3. an override with evidence");
{
  const at = new Date("2026-09-14T06:00:05.000Z");
  const model = composeRefreshPoliciesReadModel([
    input("BANK"),
    input("WALLET", { row: { value: "12h", updatedAt: new Date("2026-09-13T18:32:00.000Z"), updatedById: "u1" }, updatedByName: "Chris",
      evidence: { job: "sync-crypto", startedAt: at, policyVersion: "WALLET:6h:default" } }),
  ], NOW);
  const html = render({ data: model, loading: false, error: null });
  check("effective 12h, overdue after 15 hours, legend Override 12 h", /Every 12 hours/.test(html) && /overdue after 15 hours/.test(html) && /Override 12 h/.test(html));
  check("latest sweep is Pending with the next-attempt sentence, on the observation line", /Latest sweep: /.test(html) && /Pending/.test(html) && /next scheduled attempt/.test(html));
  check("provenance shows the UTC date and the writer's name", /Override set 13 Sept? 2026, 18:32 UTC by Chris/.test(html));
}

console.log("\n4. loading and failure states are distinct from data");
{
  const loading = render({ data: null, loading: true, error: null });
  check("loading state is a status line, not an empty policy", /role="status"/.test(loading) && !/Every/.test(loading));
  const failed = render({ data: null, loading: false, error: "Request failed (500)" });
  check("failure is an alert and shows no cadence", /role="alert"/.test(failed) && !/Every/.test(failed));
}

console.log("\n5. read-only for READ and WRITE operators — the same facts, no actionable control");
{
  const model = composeRefreshPoliciesReadModel([input("BANK"), input("WALLET", { row: { value: "12h", updatedAt: NOW, updatedById: null } })], NOW);
  const html = render({ data: model, loading: false, error: null }, false, { cadence: cadenceState });
  check("no select, input, button or form in the markup without canControl", !/<select|<input|<button|<form/.test(html));
  check("no Edit, Save or Reset affordance", !/ Edit<\/button>|Save|Reset to default/.test(html));
  check("the same policy information is still shown (effective, overdue, capability, actual)", /Every 12 hours/.test(html) && /15 hours/.test(html) && /4h · 6h · 8h · 12h · 24h/.test(html) && /Unknown/.test(html));
  check("no email, no secret-shaped text", !/@|token|secret/i.test(html));
}

console.log("\n6. the control (Slice 2) — rendered only behind canControl");
{
  const model = composeRefreshPoliciesReadModel([input("BANK"), input("WALLET")], NOW);
  const html = render({ data: model, loading: false, error: null }, true);
  check("wallet offers Edit (alternatives exist); no Reset (no override)", / Edit<\/button>/.test(html) && !/Reset to default/.test(html));
  check("bank offers Edit too since P1 (6h–24h are honourable); neither offers Reset (no override)", (html.match(/ Edit<\/button>/g) ?? []).length === 2 && !/Reset to default/.test(html));
  const withOverride = composeRefreshPoliciesReadModel([input("BANK", { row: { value: "24h", updatedAt: NOW, updatedById: null } }), input("WALLET")], NOW);
  const html2 = render({ data: withOverride, loading: false, error: null }, true);
  check("a bank override makes Reset available even though no alternative cadence exists", /Reset to default/.test(html2));
  const invalidBank = composeRefreshPoliciesReadModel([input("BANK", { row: { value: "soon", updatedAt: NOW, updatedById: null } })], NOW);
  const html3 = render({ data: invalidBank, loading: false, error: null }, true);
  check("an invalid bank override offers Edit (to replace it) and Reset", / Edit<\/button>/.test(html3) && /Reset to default/.test(html3));
}

console.log("\n7. the unified editor: bounded options, unsupported disabled with reasons, consequences, REQUIRED reason, Save gating, two-step reset");
{
  const model = composeRefreshPoliciesReadModel([input("WALLET", { row: { value: "6h", updatedAt: NOW, updatedById: null } })], NOW);
  const view = model.policies[0];
  const editor = (selected: "4h" | "6h" | "8h" | "12h" | "24h", intent: "edit" | "reset" = "edit", busy = false) =>
    renderToStaticMarkup(createElement(PolicyEditor, { view, selected, intent, busy, notice: null, onSelect: () => {}, onSave: () => {}, onReset: () => {}, onCancel: () => {} }));
  const at12 = editor("12h");
  check("all five cadences are listed", ["Every 4 hours", "Every 6 hours", "Every 8 hours", "Every 12 hours", "Every 24 hours"].every((t) => at12.includes(t)));
  check("every wallet cadence is selectable (all at or above the 4h floor)", !/Unavailable/.test(at12));
  check("12h consequences: overdue after 15 hours, half as many opportunities, no refresh now",
    /overdue after 15 hours/.test(at12) && /half as many scheduled refresh opportunities/.test(at12) && /refreshes nothing now/.test(at12));
  check("D7: a reason select over the operator reason codes with NO default, and an optional note",
    /<select[^>]*required/.test(at12) && /Choose a reason…/.test(at12) && /support request/.test(at12) && /policy rollout/.test(at12) && /Note \(optional, no personal data\)/.test(at12));
  check("Save is disabled until a reason is chosen (and the selection changed)", /<button[^>]*disabled=""[^>]*>[^<]*<svg[^>]*>[\s\S]*?Save/.test(at12));
  check("the form offers Reset to default (an override exists) and Cancel in the same footer", /Reset to default/.test(at12) && /Cancel/.test(at12));
  const at24 = editor("24h");
  check("24h consequences: overdue after 30 hours, a quarter as many opportunities", /overdue after 30 hours/.test(at24) && /a quarter as many/.test(at24));
  check("no dollar claims anywhere in the editor", !/\$/.test(at12) && !/cost|saving/i.test(at12));
  const reset = editor("6h", "reset");
  check("reset intent: asks for confirmation, says nothing is refreshed now, hides the value control, still requires a reason",
    /Confirm reset/.test(reset) && /Nothing is refreshed now/.test(reset) && !/Expected refresh cadence/.test(reset) && /Choose a reason…/.test(reset) && !/ Save<\/button>/.test(reset));
  const noOverride = composeRefreshPoliciesReadModel([input("WALLET")], NOW).policies[0];
  const noReset = renderToStaticMarkup(createElement(PolicyEditor, { view: noOverride, selected: "12h", busy: false, notice: null, onSelect: () => {}, onSave: () => {}, onReset: () => {}, onCancel: () => {} }));
  check("no override ⇒ no Reset button in the form", !/Reset to default/.test(noReset));
}

console.log("\n8. the job editor shares the same layout");
{
  const html = renderToStaticMarkup(createElement(JobCadenceEditor, { view: JOBS[2], busy: false, notice: null, onSave: () => {}, onReset: () => {}, onCancel: () => {} }));
  check("hours within floor–max, reason select, note, Save / Reset to default / Cancel", /floor 6 · max 168/.test(html) && /Choose a reason…/.test(html) && /Note \(optional/.test(html) && / Save<\/button>/.test(html) && /Reset to default/.test(html) && /Cancel/.test(html));
  check("runs nothing now", /runs nothing now/.test(html));
  const noOverride = renderToStaticMarkup(createElement(JobCadenceEditor, { view: JOBS[1], busy: false, notice: null, onSave: () => {}, onReset: () => {}, onCancel: () => {} }));
  check("no override ⇒ no Reset in the job form either", !/Reset to default/.test(noOverride));
}

console.log("\n9. execution cadence: three declared groups, the sentence once per group, Fixed collapsed");
{
  const panel = (canControl = false, extra: Record<string, unknown> = {}) =>
    renderToStaticMarkup(createElement(JobCadencePanel, { state: cadenceState as never, canControl, onModel: () => {}, ...extra }));
  const html = panel();
  const groups = groupJobCadences(JOBS);
  check("grouping: 3 editable · 3 governed · 5 fixed", groups.editable.length === 3 && groups.governed.length === 3 && groups.fixed.length === 5
    && groups.editable.map((j) => j.job).join() === "fetch-fx-rates,fetch-security-prices,evaluate-alerts"
    && groups.governed.map((j) => j.job).join() === "sync-banks,sync-crypto,sync-crypto-continuation");
  check("group titles rendered in order", /Editable[\s\S]*Governed by the refresh policy[\s\S]*Fixed \(5 maintenance jobs\)/.test(html));
  check("the explanatory sentence appears once per group, not per row",
    (html.match(/A change requires a reason, runs nothing now/g) ?? []).length === 1 && (html.match(/Change them through the refresh policy/g) ?? []).length === 1 && (html.match(/no override and nothing to edit/g) ?? []).length === 1
      && !/Default: every 24 hours\./.test(html) && !/Governed by the bank refresh policy\./.test(html));
  check("Fixed is a <details> collapsed by default", /<details[^>]*>(?![^<]*open)/.test(html) && !/<details[^>]*open/.test(html) && /<summary/.test(html));
  check("every job is present", JOBS.every((j) => html.includes(j.job)));
  check("editable rows carry the four-chip legend; governed and fixed rows do not", (html.match(/Floor 6 h/g) ?? []).length === 2 && /Floor 1 h/.test(html) && (html.match(/aria-label="Cadence bounds"/g) ?? []).length === 3);
  check("legend for the override row: Default 24 h · Override 12 h · Floor 6 h · Max 168 h", /Default 24 h/.test(html) && /Override 12 h/.test(html) && /Max 168 h/.test(html));
  check("provenance chips: Platform default / Override set <date> (no invented name) / Refresh policy / Follows sync-crypto / Fixed",
    /Platform default/.test(html) && /Override set 13 Sept? 2026, 18:32 UTC</.test(html) && !/Override set [^<]*by/.test(html) && /Refresh policy/.test(html) && /Follows sync-crypto/.test(html) && (html.match(/>Fixed</g) ?? []).length === 5);
  check("the observation line: last run with status · next due; never-ran rows say so", /Last run 14 Sept? 2026, 06:30 UTC \(succeeded\) · next due 15 Sept? 2026/.test(html) && /Never ran · due at the next wake/.test(html) && /next after sync-crypto defers work/.test(html));
  check("the wake sentence once", (html.match(/woken every 15 minutes/g) ?? []).length === 1);
  check("no controls without canControl (details/summary are disclosure, not controls)", !/<button|<select|<input|<form/.test(html));
  const control = panel(true);
  check("with canControl: Edit on the three editable rows, Reset only on the override row", (control.match(/ Edit<\/button>/g) ?? []).length === 3 && (control.match(/Reset to default/g) ?? []).length === 1);
  const wired = panel(false, { onOpenWorkspace: () => {} });
  check("every row's observation line carries the Jobs doorway", (wired.match(/aria-label="Open Jobs"/g) ?? []).length === JOBS.length);
}

console.log("\n10. the wording helpers");
{
  const model = composeRefreshPoliciesReadModel([input("WALLET", { row: { value: "8h", updatedAt: NOW, updatedById: null } })], NOW);
  const v = model.policies[0];
  check("cadenceText", cadenceText("6h") === "Every 6 hours" && cadenceText("1h") === "Every 1 hour");
  check("originText for an override", originText(v) === "Override set on the platform");
  check("an 8h wallet override reads Supported since P1", schedulerSupportText(v).word === "Supported");
  const below = composeRefreshPoliciesReadModel([input("BANK", { row: { value: "4h", updatedAt: NOW, updatedById: null } })], NOW).policies[0];
  check("a cadence below the floor reads Not supported with the floor's reason", schedulerSupportText(below).word === "Not supported" && /floor of 6 hours/.test(schedulerSupportText(below).reason ?? ""));
  check("effectiveHeadline for a valid override", effectiveHeadline(v).value === "Every 8 hours");
  check("refreshLegend", refreshLegend(v).map((i) => `${i.label} ${i.value}`).join(" · ") === "Default 6 h · Override 8 h · Floor 4 h · Max 24 h");
  check("refreshProvenance with no writer name", refreshProvenance(v, fmt) === `Override set ${fmt(NOW.toISOString())}`);
  check("jobLegend / jobProvenance", jobLegend(JOBS[1]).map((i) => i.value).join() === "24 h,—,6 h,168 h" && jobProvenance(JOBS[4], fmt) === "Follows sync-crypto" && jobProvenance(JOBS[5], fmt) === "Fixed");
  check("policiesFootnote carries the grace rule and the reason requirement", /larger of 2 hours and 25%/.test(policiesFootnote({ floorHours: 2, share: 0.25 })) && /requires a reason/.test(policiesFootnote({ floorHours: 2, share: 0.25 })));
}

console.log("\n10b. BETA C7 — the Cost safeguards group: two thresholds + the allowance dimension, DISPLAY ONLY");
{
  const safeguards = (over: Partial<AiSpendResponse["safeguards"]["thresholds"]> = {}): AiSpendResponse["safeguards"] => ({
    thresholds: {
      fleet: { key: "ai_spend_alert_fleet_usd_24h", label: "AI spend alert — fleet (USD / 24 h)", usd: 10, defaultUsd: 10, origin: "DEFAULT", updatedAt: null },
      user: { key: "ai_spend_alert_user_usd_24h", label: "AI spend alert — per customer (USD / 24 h)", usd: 3, defaultUsd: 3, origin: "DEFAULT", updatedAt: null },
      ...over,
    },
    allowance: { key: "aiDailyUsdAllowance", label: "AI daily allowance (USD, estimated)", description: "Estimated AI spend a customer may cause per UTC day.", ceilingUsd: 20,
      policy: { key: "BETA_FULL_ACCESS_V1", label: "Beta — full access (v1)", usd: 5 }, overlay: { key: "FOUNDER_INTERNAL_V1", label: "Founder / internal (v1)", usd: 20 } },
    // AI COST CONTROLS — the rule split (ai-spend-high → fleet + user) and the controls route; shape pins re-pinned by Agent A.
    alertRuleId: "ai-spend-fleet-high and ai-spend-user-high", alertRuleIds: { fleet: "ai-spend-fleet-high", user: "ai-spend-user-high" },
    thresholdWritePath: "set in Policies → AI Cost Controls (/api/platform/platform-ops/ai-cost-controls, CONTROL, reason required)",
    controlsUrl: "/api/platform/platform-ops/ai-cost-controls", checkedAt: NOW.toISOString(),
  });
  const panel = (s: AiSpendResponse["safeguards"] | null, loading = false, error: string | null = null) =>
    renderToStaticMarkup(createElement(CostSafeguardsPanel, { state: { data: s ? { spend: null as never, safeguards: s } : null, loading, error } }));
  const html = panel(safeguards());
  check("the group is titled Cost safeguards and states the governing sentence (estimate, never a bill; no editor)", /Cost safeguards/.test(html) && /never a bill/.test(html) && /no editor here/.test(html));
  check("both thresholds: figure per 24 h, the default, the provenance", /\$10 \/ 24 h/.test(html) && /\$3 \/ 24 h/.test(html) && /default \$10/.test(html) && /default \$3/.test(html) && (html.match(/Platform default/g) ?? []).length === 2);
  check("the allowance dimension: policy value, overlay value, ceiling, per UTC day, estimated, catalogue provenance",
    /Beta — full access \(v1\) \$5 · Founder \/ internal \(v1\) \$20 · ceiling \$20 · per UTC day, estimated/.test(html) && /Catalogue \(code-owned\)/.test(html));
  check("the allowance line says where it is refused and which rule judges the thresholds", /Conversations and Daily Brief routes/.test(html) && /rule ai-spend-fleet-high and ai-spend-user-high/.test(html));
  check("READ-ONLY: no button, select, input or form; no Edit, Save or Reset", !/<button|<select|<input|<form/.test(html) && !/ Edit<\/button>|Save|Reset to default/.test(html));
  check("no email, no secret-shaped text", !/@|token|secret/i.test(html));
  const set = panel(safeguards({ fleet: { key: "ai_spend_alert_fleet_usd_24h", label: "AI spend alert — fleet (USD / 24 h)", usd: 25, defaultUsd: 10, origin: "SETTING", updatedAt: "2026-10-14T09:00:00.000Z" } }));
  check("a stored threshold reads as set via admin settings with its UTC date, the default still named", /\$25 \/ 24 h/.test(set) && /Set via admin settings 14 Oct 2026, 09:00 UTC/.test(set) && /default \$10/.test(set));
  const bad = panel(safeguards({ user: { key: "ai_spend_alert_user_usd_24h", label: "AI spend alert — per customer (USD / 24 h)", usd: 3, defaultUsd: 3, origin: "INVALID_SETTING", updatedAt: "2026-10-14T09:00:00.000Z" } }));
  check("an unreadable stored value: the default is in force and the row SAYS so (alert), never 'no threshold'", /\$3 \/ 24 h/.test(bad) && /stored value is invalid/.test(bad) && /role="alert"/.test(bad) && /default is in force/.test(bad));
  check("loading is a status line; failure is an alert naming the subject", /role="status"/.test(panel(null, true)) && /role="alert"/.test(panel(null, false, "Request failed (500)")) && /cost safeguards/.test(panel(null, false, "x")));
  // Inside the Policies surface, for a READ operator: still no control anywhere.
  const model = composeRefreshPoliciesReadModel([input("BANK"), input("WALLET")], NOW);
  const inSurface = render({ data: model, loading: false, error: null }, false, { cadence: cadenceState, safeguards: { data: { spend: null as never, safeguards: safeguards() }, loading: false, error: null } });
  check("composed into the Policies surface below the cadence panel, and the whole surface stays control-free for READ", /Cost safeguards/.test(inSurface) && /\$10 \/ 24 h/.test(inSurface) && !/<button|<select|<input|<form/.test(inSurface));
  const forControl = render({ data: model, loading: false, error: null }, true, { cadence: cadenceState, safeguards: { data: { spend: null as never, safeguards: safeguards() }, loading: false, error: null } });
  check("even for a control-plane operator the safeguards group offers no editor (no Edit/Reset near a threshold)", !/\$10 \/ 24 h[\s\S]{0,600}Edit<\/button>/.test(forControl));
  const widget = readFileSync("components/platform/widgets/OpsPoliciesWidget.tsx", "utf8");
  check("source: the safeguards read is a GET of the ai-spend route; the widget never PATCHes it", /AI_SPEND_URL = "\/api\/platform\/platform-ops\/ai-spend"/.test(widget) && !/method: "PATCH"[\s\S]{0,200}ai-spend|ai-spend[\s\S]{0,200}method: "PATCH"/.test(widget));
}

console.log("\n11. source: the PATCH and DELETE bodies carry the reason; canControl gates rendering only");
{
  const src = readFileSync("components/platform/widgets/OpsPoliciesWidget.tsx", "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  check("refresh PATCH body: sourceKind, cadence, expectedUpdatedAt, reason", /mutatePolicy\("PATCH", \{ sourceKind: view\.sourceKind, cadence: selected, expectedUpdatedAt: view\.desired\.updatedAt, reason \}\)/.test(src));
  check("refresh DELETE body: sourceKind, expectedUpdatedAt, reason", /mutatePolicy\("DELETE", \{ sourceKind: view\.sourceKind, expectedUpdatedAt: view\.desired\.updatedAt, reason \}\)/.test(src));
  check("job PATCH / DELETE bodies carry the reason too", /mutateCadence\("PATCH", \{ job: view\.job, hours, expectedUpdatedAt: view\.updatedAt, reason \}\)/.test(src) && /mutateCadence\("DELETE", \{ job: view\.job, expectedUpdatedAt: view\.updatedAt, reason \}\)/.test(src));
  check("controls render only behind canControl", /offerEdit = canControl &&/.test(src) && /offerReset = canControl &&/.test(src));
  check("no polling, no router, no hex colour", !/setInterval|useRouter|next\/link/.test(src) && !/#[0-9a-f]{3,6}\b/i.test(src));
}

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
