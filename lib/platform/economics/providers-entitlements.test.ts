/**
 * lib/platform/economics/providers-entitlements.test.ts  (Platform Economics — PR B)
 *
 * Providers (cost view) and Entitlements (cost by policy group, HYPOTHETICAL
 * scenarios), pinned:
 *   1. providers — OpenAI from the AI ledger; Plaid Item-months × rate with
 *      Investments NOT evidenced (billed_products not stored ⇒ PARTIAL, never
 *      priced); every other provider UNAVAILABLE "not metered"; calls MEASURED;
 *      quota "cap unknown" everywhere; health links to Providers, never restated;
 *   2. entitlements — grouping by CURRENT assignment (none / retired ⇒ default),
 *      opaque refs, a group without cost is UNAVAILABLE (never $0), and
 *      Σ groups + unattributed = the attributable whole;
 *   3. drill = KPI for every PR B figure, through the real reader;
 *   4. scenarios — HYPOTHETICAL, capped per customer-day, own-allowance customers
 *      left uncapped, invalid queries refused, and the scenario path WRITES NOTHING
 *      (static pin over every PR B file);
 *   5. 375 px + render — no fixed widths, no "$0.00" for an unavailable figure, no
 *      apply / save control on the scenario.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/platform/economics/providers-entitlements.test.ts
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { SpendGroup } from "@/lib/platform/ai/spend-by-surface-core";
import type { UserSpendGroup } from "@/lib/platform/ai/spend-health";
import type { PlaidItemFact, PlaidItemTransition } from "@/lib/platform/plaid/item-months";
import type { PolicyGroupCatalogue } from "@/lib/entitlements/policy-groups";
import { POLICY_GROUP_KEY_PATTERN } from "@/lib/entitlements/policy-groups";
import { PLAID_RATES } from "@/lib/usage/pricing";
import { getPlatformWorkspace } from "@/lib/platform/workspaces";
import { parseEconomicsDrillQuery, REASON_INVESTMENTS_NOT_EVIDENCED, REASON_OTHER_PROVIDERS_NOT_METERED } from "@/lib/platform/economics/snapshot-core";
import { CAP_UNKNOWN, PROVIDER_HEALTH_WORKSPACE } from "@/lib/platform/economics/providers-core";
import { REASON_NO_GROUP_COST, SCENARIO_LABEL, parseScenarioQuery } from "@/lib/platform/economics/entitlements-core";
import {
  getAnyEconomicsDrill, getEconomicsEntitlements, getEconomicsProviders, getEconomicsScenario,
  type ProvidersEntitlementsDeps,
} from "@/lib/platform/economics/providers-entitlements";
import { EconomicsProvidersSurface } from "@/components/platform/leads/EconomicsProvidersLead";
import { EconomicsEntitlementsSurface, ScenarioResult } from "@/components/platform/leads/EconomicsEntitlementsLead";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const near = (a: number | null | undefined, b: number | null) => (a == null || b === null ? (a ?? null) === b : Math.abs(a - b) < 1e-9);

// ── Synthetic fixtures (no real figures) ────────────────────────────────────────

const NOW = Date.parse("2026-11-03T12:00:00Z");
// gpt-5-mini: 1M prompt × $0.25/M + 0.5M completion × $2/M = $1.25 per group.
const g = (day: string, surface: string | null, o: Partial<SpendGroup> = {}): SpendGroup => ({
  provider: "OPENAI", model: "gpt-5-mini", surface, day, invocations: 2, promptTokens: 1_000_000, cachedPromptTokens: 0, completionTokens: 500_000, ...o,
});
const ug = (userId: string | null, day: string, o: Partial<SpendGroup> = {}): UserSpendGroup => ({ ...g(day, "chat", o), userId });

const USER_GROUPS: UserSpendGroup[] = [
  ug("u_alpha", "2026-11-01"), ug("u_alpha", "2026-11-02"), ug("u_alpha", "2026-11-02"),   // $1.25 + $2.50 (one day over $2)
  ug("u_bravo", "2026-11-01"),                                                               // $1.25
  ug("u_charlie", "2026-11-02"),                                                             // $1.25 — no assignment ⇒ default
  ug("u_delta", "2026-11-03"),                                                               // $1.25 — retired group ⇒ default
  ug("u_echo", "2026-11-01"), ug("u_echo", "2026-11-01"),                                    // $2.50 — own allowance
  ug(null, "2026-11-02"),                                                                    // $1.25 — user-less customer surface
];
// The fleet ledger (every surface) this cycle: the customer calls above + $1.25 harness overhead.
const FLEET: SpendGroup[] = [...USER_GROUPS.map(({ userId: _u, ...rest }) => rest), g("2026-11-03", "harness")];

const item = (id: string, o: Partial<PlaidItemFact> = {}): PlaidItemFact => ({
  id, externalItemId: `ext_${id}`, createdAt: "2026-08-01T00:00:00Z", status: "ACTIVE", investmentsConsent: null, environment: "production", plaidEnvironment: "production", ...o,
});
const ITEMS: PlaidItemFact[] = [item("i_a"), item("i_b", { investmentsConsent: "ENABLED" }), item("i_orphan")];
const OWNERS = [{ id: "i_a", userId: "u_alpha" }, { id: "i_b", userId: "u_bravo" }, { id: "i_orphan", userId: null }];
const TRANSITIONS: PlaidItemTransition[] = [{ plaidItemId: "i_gone", at: "2026-08-15T00:00:00Z", from: "ACTIVE", to: "REVOKED" }];

const grp = (key: string, label: string, allowance: number, o: Record<string, unknown> = {}) => ({
  key, label, description: "", values: { aiDailyUsdAllowance: allowance }, valid: true, invalidReasons: [], archived: false, archivedAt: null,
  isDefault: false, builtIn: true, version: null, source: "CODE", effectiveFrom: "2026-10-01", ...o,
});
const CATALOGUE = {
  source: "CODE", defaultKey: "STANDARD", loadedAt: null,
  groups: { STANDARD: grp("STANDARD", "Standard", 5, { isDefault: true }), BETA_PLUS: grp("BETA_PLUS", "Beta plus", 10), EMPTY_GROUP: grp("EMPTY_GROUP", "Empty", 2) },
} as unknown as PolicyGroupCatalogue;
const ASSIGNMENTS = [
  { userId: "u_alpha", policyGroup: "STANDARD", overlay: null, aiDailyUsdAllowanceOverride: null },
  { userId: "u_bravo", policyGroup: "BETA_PLUS", overlay: null, aiDailyUsdAllowanceOverride: null },
  { userId: "u_delta", policyGroup: "RETIRED_GROUP", overlay: null, aiDailyUsdAllowanceOverride: null },
  { userId: "u_echo", policyGroup: "STANDARD", overlay: null, aiDailyUsdAllowanceOverride: 12 },
];
const IDS = ["u_alpha", "u_bravo", "u_charlie", "u_delta", "u_echo"];

function deps(o: { calls?: { provider: string; calls: number }[] | null; userGroups?: UserSpendGroup[]; items?: PlaidItemFact[] } = {}): ProvidersEntitlementsDeps & { writes: string[] } {
  const writes: string[] = [];
  return {
    writes,
    groups: async () => FLEET,
    plaidReaders: { items: async () => o.items ?? ITEMS, transitions: async () => TRANSITIONS },
    engagedSince: async () => new Set(IDS),
    aiPricingConfigured: true,
    plaidRates: PLAID_RATES,
    ref: (id) => `user #${id.replace("u_", "")}`,
    providerCalls: async () => (o.calls === undefined ? [{ provider: "OPENAI", calls: 9 }, { provider: "PLAID", calls: 40 }, { provider: "ALCHEMY", calls: 120 }, { provider: "RESEND", calls: 3 }] : o.calls),
    userGroups: async () => o.userGroups ?? USER_GROUPS,
    itemOwners: async () => OWNERS,
    assignments: async (ids) => ASSIGNMENTS.filter((a) => ids.includes(a.userId)),
    catalogue: async () => CATALOGUE,
  };
}

async function main() {
  // ── 1. Providers ─────────────────────────────────────────────────────────────
  console.log("1. providers (cost view)");
  const pv = await getEconomicsProviders(NOW, deps());
  const P = (id: string) => pv.providers.find((p) => p.id === id)!;
  check("OpenAI · this cycle from the AI ledger: ESTIMATED, every surface (9 customer groups + 1 harness, × $1.25)", P("OPENAI").cost.status === "ESTIMATED" && near(P("OPENAI").cost.value, 12.5), `${P("OPENAI").cost.status} ${P("OPENAI").cost.value}`);
  check("Plaid: Transactions Item-months × rate (3 Items × $0.30), Investments NOT priced ⇒ PARTIAL with the billed_products gap named",
    P("PLAID").cost.status === "PARTIAL" && near(P("PLAID").cost.value, 0.9) && P("PLAID").cost.coverage.missing.some((m) => m.includes(REASON_INVESTMENTS_NOT_EVIDENCED)), `${P("PLAID").cost.value} ${P("PLAID").cost.coverage.missing}`);
  check("other providers: UNAVAILABLE 'not metered', null, no drill", ["ALCHEMY", "RESEND"].every((id) => P(id).cost.status === "UNAVAILABLE" && P(id).cost.value === null && P(id).cost.reason === REASON_OTHER_PROVIDERS_NOT_METERED && P(id).cost.drill === null));
  check("calls this cycle are MEASURED counts", P("ALCHEMY").calls.status === "MEASURED" && P("ALCHEMY").calls.value === 120 && P("OPENAI").calls.value === 9);
  check("quota is 'cap unknown' everywhere (no cap is invented)", pv.providers.every((p) => p.quota.cap === null && p.quota.text === CAP_UNKNOWN));
  check("health is a LINK to the Providers workspace (a live workspace), never a verdict here",
    pv.providers.every((p) => p.health.workspaceId === PROVIDER_HEALTH_WORKSPACE) && getPlatformWorkspace(PROVIDER_HEALTH_WORKSPACE) != null
      && !/verdict|HEALTHY|DEGRADED|FAILING/.test(JSON.stringify(pv)));
  const noCalls = await getEconomicsProviders(NOW, deps({ calls: null }));
  check("counter unavailable ⇒ calls UNAVAILABLE (null), never 0; only OpenAI + Plaid listed", noCalls.providers.every((p) => p.calls.value === null && p.calls.status === "UNAVAILABLE") && noCalls.providers.length === 2);
  const txOnly = await getEconomicsProviders(NOW, deps({ items: [item("i_a"), item("i_orphan")] }));
  check("Transactions only, census complete ⇒ Plaid ESTIMATED", txOnly.providers.find((p) => p.id === "PLAID")!.cost.status === "ESTIMATED", JSON.stringify(txOnly.providers.find((p) => p.id === "PLAID")!.cost.coverage));
  check("metered / unmetered counts", pv.metered === 2 && pv.unmetered === 2);

  // ── 2. Entitlements ──────────────────────────────────────────────────────────
  console.log("2. entitlements (cost by policy group)");
  const ev = await getEconomicsEntitlements(NOW, deps());
  const G = (k: string) => ev.groups.find((x) => x.key === k)!;
  // STANDARD: alpha ($3.75 AI + $0.30 Plaid) + charlie ($1.25, unassigned) + delta ($1.25, retired group) + echo ($2.50) = $9.05.
  check("STANDARD (default) gets its members + the unassigned + the retired-group customer", near(G("STANDARD").cost.value, 9.05) && G("STANDARD").customersWithCost === 4, `${G("STANDARD").cost.value} ${G("STANDARD").customersWithCost}`);
  // BETA_PLUS: bravo $1.25 AI + $0.30 Transactions; the consented Investments month is named, not priced.
  check("BETA_PLUS: AI + Transactions; Investments not evidenced ⇒ PARTIAL", near(G("BETA_PLUS").cost.value, 1.55) && G("BETA_PLUS").cost.status === "PARTIAL"
    && G("BETA_PLUS").cost.coverage.missing.some((m) => m.includes(REASON_INVESTMENTS_NOT_EVIDENCED)), `${G("BETA_PLUS").cost.value} ${G("BETA_PLUS").cost.coverage.missing}`);
  check("a group with no costed customer is UNAVAILABLE (null), never $0", G("EMPTY_GROUP").cost.value === null && G("EMPTY_GROUP").cost.status === "UNAVAILABLE" && G("EMPTY_GROUP").cost.reason === REASON_NO_GROUP_COST);
  check("every costed group is PARTIAL (infrastructure + unmetered providers never attributed)", ev.groups.filter((x) => x.cost.value !== null).every((x) => x.cost.status === "PARTIAL"));
  check("the group's configured allowance travels with it (config, not spend)", G("STANDARD").allowanceUsd === 5 && G("BETA_PLUS").allowanceUsd === 10);
  // Unattributed: harness $1.25 + user-less $1.25 + orphan Item $0.30.
  check("unattributed = AI overhead + user-less calls + ownerless Items, its own figure", near(ev.unattributed.value, 2.8), `${ev.unattributed.value}`);
  const groupsAi = 3.75 + 1.25 + 1.25 + 1.25 + 2.5; // every attributed customer's AI
  check("Σ groups + unattributed = the attributable whole (fleet AI + Plaid Transactions)",
    near(ev.groups.reduce((a, x) => a + (x.cost.value ?? 0), 0) + (ev.unattributed.value ?? 0), P("OPENAI").cost.value! + 0.9) && near(groupsAi + 1.25 + 1.25, P("OPENAI").cost.value));
  const json = JSON.stringify(ev);
  check("no user id leaves the reader (opaque refs only)", IDS.every((id) => !json.includes(id)));

  // ── 3. Drill = KPI ───────────────────────────────────────────────────────────
  console.log("3. drill = KPI");
  const viaHref = async (href: string) => {
    const q = parseEconomicsDrillQuery(new URL(href, "http://x").searchParams, NOW + 60_000);
    return q ? getAnyEconomicsDrill(q, deps()) : null;
  };
  for (const p of pv.providers.filter((x) => x.cost.drill)) {
    const d = await viaHref(p.cost.drill!.href);
    check(`${p.id}: drill total = KPI (${p.cost.value}); same status`, d !== null && near(d.total, p.cost.value) && d.figure.status === p.cost.status && near(d.figure.value, p.cost.value));
  }
  for (const x of ev.groups.filter((y) => y.cost.drill)) {
    const d = await viaHref(x.cost.drill!.href);
    check(`group ${x.key}: drill rows = its customers (opaque refs), total = KPI`, d !== null && near(d.total, x.cost.value) && d.rows.length === x.customersWithCost && d.rows.every((r) => r.id.startsWith("user #")));
  }
  const ud = await viaHref(ev.unattributed.drill!.href);
  check("unattributed: drill total = KPI", ud !== null && near(ud.total, ev.unattributed.value));
  check("drill parse: group_cost needs a catalogue-shaped group; an unknown group is no drill",
    parseEconomicsDrillQuery(new URLSearchParams({ figure: "group_cost" }), NOW) === null
      && parseEconomicsDrillQuery(new URLSearchParams({ figure: "group_cost", group: "lower" }), NOW) === null
      && (await getAnyEconomicsDrill({ figure: "group_cost", window: "cycle", untilMs: NOW, group: "NOT_A_GROUP" }, deps())) === null);
  check("an unmetered provider has no records endpoint", parseEconomicsDrillQuery(new URLSearchParams({ figure: "provider_unmetered" }), NOW) === null);

  // ── 4. Scenarios ─────────────────────────────────────────────────────────────
  console.log("4. scenarios (HYPOTHETICAL, read-only)");
  const s = await getEconomicsScenario(new URLSearchParams({ group: "STANDARD", allowance: "2" }), NOW, deps());
  check("labelled HYPOTHETICAL", s !== null && s.label === SCENARIO_LABEL && s.hypothetical === true && /HYPOTHETICAL/.test(s.hypotheticalCost.label) && /HYPOTHETICAL/.test(s.note));
  // STANDARD AI: alpha 1.25 + 2.50 (Nov 2 over $2 ⇒ 2.00), charlie 1.25, delta 1.25, echo 2.50 (own allowance ⇒ uncapped).
  check("recorded vs capped: only alpha's Nov 2 is capped; echo (own allowance) is not", s !== null && near(s.current.value, 8.75) && near(s.hypotheticalCost.value, 8.25) && near(s.differenceUsd, 0.5)
    && s.customerDaysOver === 1 && s.customersAffected === 1 && s.ownAllowanceCustomers === 1, s ? `${s.current.value} ${s.hypotheticalCost.value} ${s.customerDaysOver}` : "null");
  check("the scenario carries the group's configured allowance beside the proposed one", s !== null && s.currentAllowanceUsd === 5 && s.proposedAllowanceUsd === 2);
  check("refused: unknown group, negative, > 1000, non-numeric, missing",
    (await getEconomicsScenario(new URLSearchParams({ group: "NOT_A_GROUP", allowance: "2" }), NOW, deps())) === null
      && parseScenarioQuery(new URLSearchParams({ group: "STANDARD", allowance: "-1" }), POLICY_GROUP_KEY_PATTERN) === null
      && parseScenarioQuery(new URLSearchParams({ group: "STANDARD", allowance: "1001" }), POLICY_GROUP_KEY_PATTERN) === null
      && parseScenarioQuery(new URLSearchParams({ group: "STANDARD", allowance: "abc" }), POLICY_GROUP_KEY_PATTERN) === null
      && parseScenarioQuery(new URLSearchParams({ group: "STANDARD" }), POLICY_GROUP_KEY_PATTERN) === null);
  const sEmpty = await getEconomicsScenario(new URLSearchParams({ group: "EMPTY_GROUP", allowance: "1" }), NOW, deps());
  check("a group with no spend: both figures UNAVAILABLE, no difference (never $0)", sEmpty !== null && sEmpty.current.value === null && sEmpty.hypotheticalCost.value === null && sEmpty.differenceUsd === null);

  const strip = (rel: string) => readFileSync(path.join(process.cwd(), rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const PR_B = [
    "lib/platform/economics/providers-core.ts", "lib/platform/economics/entitlements-core.ts", "lib/platform/economics/providers-entitlements.ts",
    "app/api/platform/platform-ops/economics/providers/route.ts", "app/api/platform/platform-ops/economics/entitlements/route.ts",
    "app/api/platform/platform-ops/economics/scenario/route.ts", "app/api/platform/platform-ops/economics/drill/route.ts",
    "components/platform/leads/EconomicsProvidersLead.tsx", "components/platform/leads/EconomicsEntitlementsLead.tsx",
  ];
  const WRITE = /\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(|\$executeRaw|\$transaction|applyAiCostControlChanges|assignPolicyGroup|recordOperatorAction|writeSetting|method:\s*["'](POST|PUT|PATCH|DELETE)/;
  for (const f of PR_B) check(`${f}: writes nothing (no create/update/upsert/delete, no transaction, no policy/allowance mutator, no non-GET fetch)`, !WRITE.test(strip(f)), (strip(f).match(WRITE) ?? [""])[0]);
  for (const r of PR_B.filter((f) => f.startsWith("app/"))) {
    const t = strip(r);
    check(`${r}: PLATFORM_OPS READ, GET only, no-store`, /requirePlatformAccess\("PLATFORM_OPS", "READ"\)/.test(t) && !/export async function (POST|PUT|PATCH|DELETE)/.test(t) && /no-store/.test(t));
  }
  const reader = strip("lib/platform/economics/providers-entitlements.ts");
  check("the PR B reader reads through fm_system only (systemDb), never the migration principal (db)",
    /import \{ systemDb \} from "@\/lib\/db"/.test(reader) && !/\bdb\./.test(reader) && !/import \{[^}]*\bdb\b[^}]*\} from "@\/lib\/db"/.test(reader));
  const ent = strip("components/platform/leads/EconomicsEntitlementsLead.tsx");
  check("the scenario UI has no apply / save / assign control", !/>\s*(Apply|Save|Assign|Update policy|Set allowance)\b/i.test(ent) && /Compute \(read-only\)/.test(ent));

  // ── 5. Render + 375 px ──────────────────────────────────────────────────────
  console.log("5. render + 375 px");
  const ok = { loading: false, error: null };
  const ph = renderToStaticMarkup(createElement(EconomicsProvidersSurface, { view: { data: pv, ...ok }, onOpenDrill: () => {}, onOpenHealth: () => {} }));
  check("providers: unmetered render 'Unavailable', never $0.00; each row links to health; quota cap unknown",
    /data-econ-value="ALCHEMY">Unavailable</.test(ph) && !/data-econ-value="ALCHEMY">\$/.test(ph) && (ph.match(/Health in Providers/g) ?? []).length === pv.providers.length && (ph.match(/quota: cap unknown/g) ?? []).length === pv.providers.length);
  check("providers: priced rows are buttons carrying their drill href", pv.providers.filter((p) => p.cost.drill).every((p) => ph.includes(`data-econ-drill="${p.cost.drill!.href.replace(/&/g, "&amp;")}"`)));
  const eh = renderToStaticMarkup(createElement(EconomicsEntitlementsSurface, { view: { data: ev, ...ok }, onOpenDrill: () => {} }));
  check("entitlements: the empty group renders Unavailable (no $0.00 beside it); costed groups are drill buttons",
    /data-econ-group="EMPTY_GROUP"[\s\S]*?Unavailable/.test(eh) && !/data-econ-group="EMPTY_GROUP"[^]*?\$0\.00[^]*?data-econ-group/.test(eh)
      && ev.groups.filter((x) => x.cost.drill).every((x) => eh.includes(`data-econ-tile="group_cost.${x.key}"`)));
  check("entitlements: the scenario form is present and says read-only", /data-econ-scenario-form/.test(eh) && /Compute \(read-only\)/.test(eh) && /Changes no policy/.test(eh));
  const sh = renderToStaticMarkup(createElement(ScenarioResult, { s: s! }));
  check("scenario result: HYPOTHETICAL badge + headline, marked data-hypothetical", /data-hypothetical="true"/.test(sh) && /HYPOTHETICAL · (≥ )?\$8\.75 → (≥ )?\$8\.25 \(−\$0\.50\)/.test(sh) && />HYPOTHETICAL</.test(sh), sh.slice(0, 400));
  for (const f of ["components/platform/leads/EconomicsProvidersLead.tsx", "components/platform/leads/EconomicsEntitlementsLead.tsx"]) {
    const src = readFileSync(path.join(process.cwd(), f), "utf8");
    check(`${f}: 375 px — no fixed pixel width, no table, rows shrink (min-w-0) and wrap`, !/\bw-\[\d+px\]/.test(src) && !/min-w-\[\d/.test(src) && !/<table/.test(src) && (src.match(/min-w-0/g) ?? []).length >= 6 && /flex-wrap/.test(src));
    check(`${f}: no access-level literal, no viewport read`, !/"(READ|WRITE|CONTROL)"/.test(src) && !/innerWidth|matchMedia/.test(src));
  }

  if (failures > 0) { console.error(`\neconomics providers + entitlements: ${failures} failure(s).`); process.exit(1); }
  console.log("\neconomics providers + entitlements: all passed.");
}

main().catch((e) => { console.error(e); process.exit(1); });
