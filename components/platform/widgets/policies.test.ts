/**
 * components/platform/widgets/policies.test.ts  (PLATFORM OPS POLICIES — Slice 1)
 *
 * THE POLICIES SURFACE, RENDERED — every state provable by handing the
 * presentational component props, and the read-only contract pinned.
 *
 *   npx tsx components/platform/widgets/policies.test.ts
 */

import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SCHEDULED_JOBS } from "@/lib/jobs/registry";
import { schedulerCapability } from "@/lib/platform/scheduler-capability";
import { composeRefreshPoliciesReadModel, type ComposeRefreshPolicyInput } from "@/lib/platform/policies/refresh-policies.core";
import { PoliciesSurface } from "./OpsPoliciesWidget";
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
const render = (state: { data: unknown; loading: boolean; error: string | null }) =>
  renderToStaticMarkup(createElement(PoliciesSurface, { section, state: state as never }));

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

console.log("\n5. read-only means read-only");
{
  const model = composeRefreshPoliciesReadModel([input("BANK"), input("WALLET")], NOW);
  const html = render({ data: model, loading: false, error: null });
  check("no select, input, button or form in the markup", !/<select|<input|<button|<form/.test(html));
  check("no save affordance", !/Save/.test(html));
  check("no email, no secret-shaped text", !/@|token|secret/i.test(html));
  const src = readFileSync("components/platform/widgets/OpsPoliciesWidget.tsx", "utf8");
  check("no handler props in the widget source", !/onClick|onChange|onSubmit/.test(src));
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
