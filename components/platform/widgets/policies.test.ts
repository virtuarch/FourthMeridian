/**
 * components/platform/widgets/policies.test.ts  (PLATFORM OPS POLICIES — Slice 1)
 *
 * THE POLICIES SURFACE, RENDERED — every state provable by handing the
 * presentational component props, and the read-only contract pinned.
 *
 *   npx tsx components/platform/widgets/policies.test.ts
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SCHEDULED_JOBS } from "@/lib/jobs/registry";
import { schedulerCapability } from "@/lib/platform/scheduler-capability";
import { composeRefreshPoliciesReadModel, type ComposeRefreshPolicyInput } from "@/lib/platform/policies/refresh-policies.core";
import { PoliciesSurface, PolicyEditor, ResetConfirm } from "./OpsPoliciesWidget";
import { cadenceText, effectiveHeadline, originText, schedulerSupportText } from "./policies-view";

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
const render = (state: { data: unknown; loading: boolean; error: string | null }, canControl = false) =>
  renderToStaticMarkup(createElement(PoliciesSurface, { section, state: state as never, canControl }));

console.log("1. the default picture (the real database today)");
{
  const model = composeRefreshPoliciesReadModel([input("BANK"), input("WALLET")], NOW);
  const html = render({ data: model, loading: false, error: null });
  check("both sources are visible", /Bank refresh/.test(html) && /Wallet refresh/.test(html));
  check("bank: Every 24 hours · Platform default · overdue after 30 hours", /Every 24 hours/.test(html) && /30 hours/.test(html));
  check("wallet: Every 6 hours · overdue after 8 hours", /Every 6 hours/.test(html) && /8 hours/.test(html));
  check("origin reads as the platform default", (html.match(/Platform default/g) ?? []).length === 2);
  check("scheduler support reads Supported for both (the word, not a reason)", (html.match(/>Supported</g) ?? []).length === 2 && !/>Not supported</.test(html));
  check("available cadences: wallet 6h · 12h · 24h, bank 24h", /6h · 12h · 24h/.test(html) && />24h</.test(html));
  check("unsupported options carry their reasons", /effective execution would be 12 hours/.test(html) && /attempts occur every 6 hours/.test(html));
  check("attempt schedule is stated as UTC slots", /00:00, 06:00, 12:00, 18:00 UTC/.test(html) && /06:00 UTC/.test(html));
  check("latest sweep is Unknown with its reason, never a fabricated verdict", /Unknown/.test(html) && /unknown/.test(html));
  check("last changed: never overridden", (html.match(/Never overridden/g) ?? []).length === 2);
  check("grace is stated once as the code-owned rule", /larger of 2 hours and 25%/.test(html));
}

console.log("\n2. an invalid legacy override is never presented as configured");
{
  const model = composeRefreshPoliciesReadModel([input("BANK"), input("WALLET", { row: { value: "soon", updatedAt: NOW, updatedById: null } })], NOW);
  const html = render({ data: model, loading: false, error: null });
  check("headline says the DEFAULT is in force", /Default every 6 hours/.test(html));
  check("qualifier says the stored override is invalid", /stored override is invalid/.test(html));
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
  check("effective 12h, override set, overdue after 15 hours", /Every 12 hours/.test(html) && /Override set/.test(html) && /15 hours/.test(html));
  check("latest sweep is Pending with the next-attempt sentence", /Pending/.test(html) && /next scheduled attempt/.test(html));
  check("last changed shows the UTC date and the writer's name", /13 Sept? 2026, 18:32 UTC by Chris/.test(html));
}

console.log("\n4. loading and failure states are distinct from data");
{
  const loading = render({ data: null, loading: true, error: null });
  check("loading state is a status line, not an empty policy", /role="status"/.test(loading) && !/Every/.test(loading));
  const failed = render({ data: null, loading: false, error: "Request failed (500)" });
  check("failure is an alert and shows no cadence", /role="alert"/.test(failed) && !/Every/.test(failed));
}

console.log("\n5. read-only for READ and WRITE operators — the Slice 1 card, no actionable control");
{
  const model = composeRefreshPoliciesReadModel([input("BANK"), input("WALLET", { row: { value: "12h", updatedAt: NOW, updatedById: null } })], NOW);
  const html = render({ data: model, loading: false, error: null }, false);
  check("no select, input, button or form in the markup without canControl", !/<select|<input|<button|<form/.test(html));
  check("no Edit, Save or Reset affordance", !/ Edit<\/button>|Save|Reset to default/.test(html));
  check("the same policy information is still shown (effective, overdue, capability, actual)", /Every 12 hours/.test(html) && /15 hours/.test(html) && /6h · 12h · 24h/.test(html) && /Unknown/.test(html));
  check("no email, no secret-shaped text", !/@|token|secret/i.test(html));
}

console.log("\n6. the control (Slice 2) — rendered only behind canControl");
{
  const model = composeRefreshPoliciesReadModel([input("BANK"), input("WALLET")], NOW);
  const html = render({ data: model, loading: false, error: null }, true);
  check("wallet offers Edit (alternatives exist); no Reset (no override)", (html.match(/ Edit<\/button>/g) ?? []).length === 1 && !/Reset to default/.test(html));
  check("bank offers neither Edit (24h is the only honourable cadence) nor Reset (no override)", (html.match(/<button/g) ?? []).length === 1);
  const withOverride = composeRefreshPoliciesReadModel([input("BANK", { row: { value: "24h", updatedAt: NOW, updatedById: null } }), input("WALLET")], NOW);
  const html2 = render({ data: withOverride, loading: false, error: null }, true);
  check("a bank override makes Reset available even though no alternative cadence exists", /Reset to default/.test(html2));
  const invalidBank = composeRefreshPoliciesReadModel([input("BANK", { row: { value: "soon", updatedAt: NOW, updatedById: null } })], NOW);
  const html3 = render({ data: invalidBank, loading: false, error: null }, true);
  check("an invalid bank override offers Edit (to replace it) and Reset", / Edit<\/button>/.test(html3) && /Reset to default/.test(html3));
}

console.log("\n7. the editor: bounded options, unsupported disabled with reasons, consequences, Save gating");
{
  const model = composeRefreshPoliciesReadModel([input("WALLET")], NOW);
  const view = model.policies[0];
  const editor = (selected: "4h" | "6h" | "8h" | "12h" | "24h", busy = false) =>
    renderToStaticMarkup(createElement(PolicyEditor, { view, selected, busy, notice: null, onSelect: () => {}, onSave: () => {}, onCancel: () => {} }));
  const at12 = editor("12h");
  check("all five cadences are listed", ["Every 4 hours", "Every 6 hours", "Every 8 hours", "Every 12 hours", "Every 24 hours"].every((t) => at12.includes(t)));
  check("4h and 8h are disabled with the scheduler's reasons", (at12.match(/disabled=""/g) ?? []).length >= 2 && /attempts occur every 6 hours/.test(at12) && /effective execution would be 12 hours/.test(at12));
  check("12h consequences: overdue after 15 hours, half as many opportunities, no refresh now",
    /overdue after 15 hours/.test(at12) && /half as many scheduled refresh opportunities/.test(at12) && /refreshes nothing now/.test(at12));
  const at24 = editor("24h");
  check("24h consequences: overdue after 30 hours, a quarter as many opportunities", /overdue after 30 hours/.test(at24) && /a quarter as many/.test(at24));
  const unchanged = editor("6h");
  check("Save is disabled while the selection equals the cadence in force", /<button[^>]*disabled=""[^>]*>[^<]*<svg[^>]*>[\s\S]*?Save/.test(unchanged) || /disabled=""[^>]*> Save|Save<\/button>/.test(unchanged));
  check("no dollar claims anywhere in the editor", !/\$/.test(at12) && !/cost|saving/i.test(at12));
  const reset = renderToStaticMarkup(createElement(ResetConfirm, { view, busy: false, notice: null, onConfirm: () => {}, onCancel: () => {} }));
  check("reset asks for confirmation and says nothing is refreshed now", /Confirm reset/.test(reset) && /Nothing is refreshed now/.test(reset));
}

console.log("\n6. the wording helpers");
{
  const model = composeRefreshPoliciesReadModel([input("WALLET", { row: { value: "8h", updatedAt: NOW, updatedById: null } })], NOW);
  const v = model.policies[0];
  check("cadenceText", cadenceText("6h") === "Every 6 hours" && cadenceText("1h") === "Every 1 hour");
  check("originText for an override", originText(v) === "Override set on the platform");
  check("an unhonourable effective cadence reads Not supported with the reason", schedulerSupportText(v).word === "Not supported" && /12 hours/.test(schedulerSupportText(v).reason ?? ""));
  check("effectiveHeadline for a valid override", effectiveHeadline(v).value === "Every 8 hours");
}

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
