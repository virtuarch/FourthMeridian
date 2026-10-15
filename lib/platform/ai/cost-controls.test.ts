/**
 * lib/platform/ai/cost-controls.test.ts  (AI COST CONTROLS — read model + mutation service)
 *
 * The seven controls resolve from their rows (DEFAULT / SETTING / INVALID_SETTING,
 * the kill switch's unreadable row DENYING), the batch is validated before any
 * transaction, every change writes ONE setting row and ONE audit row in ONE
 * transaction (a conflict anywhere ⇒ nothing written), reset deletes, and the
 * routes carry the right gates. No live database: an in-memory Prisma stand-in
 * with an interactive $transaction that discards every write on a throw.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/platform/ai/cost-controls.test.ts
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { REASON_REQUIRED_ACTIONS } from "@/lib/audit";
import { AuditAction } from "@/lib/audit-actions";
import {
  applyAiCostControlChanges, composeAlertView, loadAiCostControlsReadModel, recentTriggersFor, validateControlChanges,
  type CostControlsClient, type CostControlsTx,
} from "./cost-controls";
import { resolveControlValue } from "./cost-controls-core";
import { AI_COST_CONTROL_KEYS, AI_COST_CONTROL_SETTING_KEYS, AI_SPEND_RULE_IDS } from "./cost-controls.types";
import { AI_PAUSED_CUSTOMER_MESSAGE } from "./paid-requests-admission";
import type { AlertRunSummary } from "@/lib/alerts/evaluate";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
process.on("unhandledRejection", (err) => {
  if ((err as { constructor?: { name?: string } })?.constructor?.name === "PrismaClientInitializationError") return;
  console.error("  ✗ unexpected:", err); process.exit(1);
});
const ROOT = process.cwd();
const strip = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const NOW = new Date("2026-10-15T18:00:00.000Z");
const T0 = new Date("2026-10-14T09:00:00.000Z");

// ── The in-memory database ────────────────────────────────────────────────────

interface Row { key: string; value: string; updatedAt: Date; updatedById: string | null }
interface State {
  settings: Map<string, Row>;
  audits: { action: string; performedByAdminId?: string; metadata: Record<string, unknown> }[];
  users: { id: string; name: string | null }[];
  runs: { summary: unknown }[];
  overrides: { userId: string; aiDailyUsdAllowanceOverride: number | null; updatedAt: Date }[];
  reads: number;
}

function makeDb(initial: Partial<State> = {}, faults: { interleave?: (s: State) => void } = {}) {
  const state: State = { settings: new Map(), audits: [], users: [{ id: "op1", name: "Dana Ops" }], runs: [], overrides: [], reads: 0, ...initial };
  let clock = Date.parse("2026-10-15T12:00:00.000Z");
  const tick = () => new Date((clock += 1000));
  let pending = faults.interleave;

  const settingsOps = (draft: State) => ({
    findMany: async ({ where }: { where: { key: { in: string[] } } }) => {
      draft.reads++;
      return [...draft.settings.values()].filter((r) => where.key.in.includes(r.key)).map((r) => ({ ...r }));
    },
    findUnique: async ({ where }: { where: { key: string } }) => {
      if (pending) { const f = pending; pending = undefined; f(state); f(draft); }
      const r = draft.settings.get(where.key); return r ? { value: r.value, updatedAt: r.updatedAt } : null;
    },
    create: async ({ data }: { data: { key: string; value: string; updatedById: string } }) => {
      if (draft.settings.has(data.key)) throw Object.assign(new Error("unique"), { code: "P2002" });
      draft.settings.set(data.key, { key: data.key, value: data.value, updatedAt: tick(), updatedById: data.updatedById }); return data;
    },
    updateMany: async ({ where, data }: { where: { key: string; updatedAt: Date }; data: { value: string; updatedById: string } }) => {
      const r = draft.settings.get(where.key);
      if (!r || r.updatedAt.getTime() !== where.updatedAt.getTime()) return { count: 0 };
      draft.settings.set(where.key, { ...r, value: data.value, updatedAt: tick(), updatedById: data.updatedById }); return { count: 1 };
    },
    deleteMany: async ({ where }: { where: { key: string; updatedAt: Date } }) => {
      const r = draft.settings.get(where.key);
      if (!r || r.updatedAt.getTime() !== where.updatedAt.getTime()) return { count: 0 };
      draft.settings.delete(where.key); return { count: 1 };
    },
    count: async ({ where }: { where: { key: string } }) => (draft.settings.has(where.key) ? 1 : 0),
  });

  const client = {
    platformSetting: settingsOps(state),
    user: { findMany: async ({ where }: { where: { id: { in: string[] } } }) => state.users.filter((u) => where.id.in.includes(u.id)) },
    jobRun: { findMany: async () => state.runs },
    customerPolicyAssignment: {
      findMany: async ({ take }: { take: number }) => state.overrides.slice(0, take),
      count: async () => state.overrides.length,
    },
    $transaction: async <T,>(fn: (tx: CostControlsTx) => Promise<T>): Promise<T> => {
      const draft: State = { ...state, settings: new Map([...state.settings].map(([k, v]) => [k, { ...v }])), audits: [...state.audits] };
      const tx = { platformSetting: settingsOps(draft), auditLog: { create: async ({ data }: { data: Record<string, unknown> }) => { draft.audits.push(data as never); } } };
      const out = await fn(tx as unknown as CostControlsTx);
      state.settings = draft.settings; state.audits = draft.audits;
      return out;
    },
  } as unknown as CostControlsClient;
  return { client, state };
}

const reason = { code: "POLICY_ROLLOUT" as const, note: "tightening for the beta cohort" };
const actor = { id: "op1", ipAddress: "203.0.113.9", userAgent: "ua" };
const K = AI_COST_CONTROL_SETTING_KEYS;

function summaryWith(fired: { ruleId: string; dedupeKey: string; at: string; severity?: "warning" | "critical" }[], firing: string[] = []): AlertRunSummary {
  return {
    evaluatedAtISO: fired[fired.length - 1]?.at ?? NOW.toISOString(), destination: "ops@example.test", deliveryStatus: fired.length ? "sent" : "none",
    counts: { evaluated: 8, live: 7, enabled: 7, firing: firing.length, delivered: fired.length, suppressed: 0 },
    rules: [AI_SPEND_RULE_IDS.fleet, AI_SPEND_RULE_IDS.user].map((id) => ({ id, kind: "ai-spend-fleet" as const, enabled: true, live: true, firing: firing.includes(id), breaches: firing.includes(id) ? 1 : 0, severity: firing.includes(id) ? "warning" as const : null })),
    fired: fired.map((f) => ({ ruleId: f.ruleId, kind: "ai-spend-fleet" as const, dedupeKey: f.dedupeKey, severity: f.severity ?? "warning", summary: "s", deliveredAtISO: f.at })),
  };
}

async function main() {
  console.log("1. the pure resolution: DEFAULT / SETTING / INVALID_SETTING, and the kill switch denies when unreadable");
  {
    const d = resolveControlValue("allowance.usd", null);
    check("no row ⇒ the contract default 5, origin DEFAULT, bounds 1…20, no version", d.value === 5 && d.origin === "DEFAULT" && d.bounds?.min === 1 && d.bounds?.max === 20 && d.updatedAt === null && d.updatedByName === null);
    const s = resolveControlValue("allowance.usd", { value: "8", updatedAt: T0, updatedById: "op1" }, "Dana Ops");
    check("a valid row ⇒ 8, SETTING, version + writer display name", s.value === 8 && s.origin === "SETTING" && s.updatedAt === T0.toISOString() && s.updatedByName === "Dana Ops");
    const bad = resolveControlValue("allowance.enforced", { value: "maybe", updatedAt: T0 });
    check("an unreadable enforcement row ⇒ the default (enforced) in force, INVALID_SETTING", bad.value === true && bad.origin === "INVALID_SETTING");
    const badKill = resolveControlValue("killSwitch.paused", { value: "yes", updatedAt: T0 });
    check("an unreadable kill-switch row ⇒ PAUSED in force (fail closed), INVALID_SETTING", badKill.value === true && badKill.origin === "INVALID_SETTING");
    check("kill switch absent ⇒ not paused, DEFAULT (ABSENT_MEANS_OFF)", resolveControlValue("killSwitch.paused", null).value === false && resolveControlValue("killSwitch.paused", null).origin === "DEFAULT");
    check("booleans carry no bounds", resolveControlValue("userAlert.enabled", null).bounds === null);
    check("the user threshold's bounds are the descriptor's 1…10000", resolveControlValue("userAlert.thresholdUsd", null).bounds?.max === 10000);
  }

  console.log("\n2. batch validation happens BEFORE any transaction");
  {
    const bad = (changes: unknown) => { const v = validateControlChanges(changes); return v.ok ? null : v; };
    check("empty / non-array refused", bad([]) !== null && bad("x") !== null);
    check("unknown control refused", /Unknown control/.test(bad([{ control: "nope", value: 1, expectedUpdatedAt: null }])?.reason ?? ""));
    check("duplicate control refused, named", bad([{ control: "allowance.usd", value: 1, expectedUpdatedAt: null }, { control: "allowance.usd", value: 2, expectedUpdatedAt: null }])?.control === "allowance.usd");
    check("a string where a number belongs is refused (no smuggling text past the descriptor)", bad([{ control: "allowance.usd", value: "5", expectedUpdatedAt: null }]) !== null);
    check("a number where a boolean belongs is refused", bad([{ control: "killSwitch.paused", value: 1, expectedUpdatedAt: null }]) !== null);
    check("0 / negative / non-integer / above the ceiling refused for the allowance", [0, -2, 4.5, 21].every((v) => bad([{ control: "allowance.usd", value: v, expectedUpdatedAt: null }]) !== null));
    check("above the fleet max refused", bad([{ control: "fleetAlert.thresholdUsd", value: 100001, expectedUpdatedAt: null }]) !== null);
    check("a malformed expectedUpdatedAt refused", bad([{ control: "allowance.usd", value: 5, expectedUpdatedAt: "yesterday" }]) !== null && bad([{ control: "allowance.usd", value: 5 }]) !== null);
    const ok = validateControlChanges([{ control: "allowance.enforced", value: false, expectedUpdatedAt: null }, { control: "allowance.usd", value: 7, expectedUpdatedAt: null }, { control: "userAlert.thresholdUsd", value: null, expectedUpdatedAt: T0.toISOString() }]);
    check("a valid batch normalises: booleans to 'false', integers to digits, null to RESET", ok.ok && ok.changes[0].kind === "SET" && (ok.changes[0] as { stored: string }).stored === "false" && (ok.changes[1] as { stored: string }).stored === "7" && ok.changes[2].kind === "RESET");
    check("at most one change per control", bad(Array.from({ length: 8 }, () => ({ control: "allowance.usd", value: 5, expectedUpdatedAt: null }))) !== null);
  }

  console.log("\n3. the read model");
  {
    const { client, state } = makeDb({
      settings: new Map([[K["allowance.usd"], { key: K["allowance.usd"], value: "8", updatedAt: T0, updatedById: "op1" }], [K["killSwitch.paused"], { key: K["killSwitch.paused"], value: "true", updatedAt: T0, updatedById: "op1" }]]),
      overrides: [{ userId: "usr_000abc123", aiDailyUsdAllowanceOverride: 12, updatedAt: T0 }],
      runs: [{ summary: summaryWith([{ ruleId: AI_SPEND_RULE_IDS.user, dedupeKey: "ai-spend-user-high:user:2026-10-15:abc123", at: "2026-10-15T12:30:00Z", severity: "critical" }], [AI_SPEND_RULE_IDS.user]) },
             { summary: summaryWith([{ ruleId: AI_SPEND_RULE_IDS.fleet, dedupeKey: "ai-spend-fleet-high:fleet:2026-10-14", at: "2026-10-14T12:30:00Z" }]) }],
    });
    const m = await loadAiCostControlsReadModel(client, NOW);
    check("every control present with its setting key", AI_COST_CONTROL_KEYS.every((c) => [m.allowance.enforced, m.allowance.usd, m.userAlert.enabled, m.userAlert.thresholdUsd, m.fleetAlert.enabled, m.fleetAlert.thresholdUsd, m.killSwitch.paused].some((v) => v.control === c && v.settingKey === K[c])));
    check("the platform allowance 8 is SETTING by Dana Ops; the effective default is PLATFORM_SETTING 8 under ceiling 20", m.allowance.usd.value === 8 && m.allowance.usd.updatedByName === "Dana Ops" && m.allowance.effectiveDefaultUsd === 8 && m.allowance.effectiveDefaultSource === "PLATFORM_SETTING" && m.allowance.ceilingUsd === 20);
    check("defaults: enforced true DEFAULT, thresholds 3 / 10 DEFAULT, alerts enabled DEFAULT", m.allowance.enforced.value === true && m.allowance.enforced.origin === "DEFAULT" && m.userAlert.thresholdUsd.value === 3 && m.fleetAlert.thresholdUsd.value === 10 && m.userAlert.enabled.value && m.fleetAlert.enabled.origin === "DEFAULT");
    check("overrides: count + opaque refs only (no full id), with the usd and version", m.allowance.overrides.count === 1 && m.allowance.overrides.customers[0].ref === "user …abc123" && m.allowance.overrides.customers[0].usd === 12 && !JSON.stringify(m.allowance.overrides).includes("usr_000abc123"));
    check("the kill switch is paused (SETTING) and carries the customer sentence", m.killSwitch.paused.value === true && m.killSwitch.paused.origin === "SETTING" && m.killSwitch.customerMessage === AI_PAUSED_CUSTOMER_MESSAGE);
    check("user alert: live, firing now from the LATEST run, last fired + recent newest first", m.userAlert.status.live && m.userAlert.status.firingNow && m.userAlert.status.lastFiredAt === "2026-10-15T12:30:00.000Z".replace(".000", "") && m.userAlert.status.recent.length === 1 && m.userAlert.status.recent[0].severity === "critical");
    check("fleet alert: live, NOT firing now, its own history only", m.fleetAlert.status.live && !m.fleetAlert.status.firingNow && m.fleetAlert.status.recent.length === 1 && m.fleetAlert.status.recent[0].dedupeKey.startsWith("ai-spend-fleet-high:"));
    check("propagation: nothing cached, and the note states the bounded guarantee", m.propagation.cached === false && /very next decision/.test(m.propagation.note) && /not absolute/.test(m.propagation.note));
    check("the enforcement note says where and when", /after authentication, entitlement, pacing and the kill switch/.test(m.allowance.enforcementNote));
    check("no email anywhere in the model", !/@/.test(JSON.stringify(m)));
    const empty = await loadAiCostControlsReadModel(makeDb().client, NOW);
    check("with no rows at all: effective default POLICY 5, no overrides, alerts never fired, not paused", empty.allowance.effectiveDefaultUsd === 5 && empty.allowance.effectiveDefaultSource === "POLICY" && empty.allowance.overrides.count === 0 && empty.userAlert.status.lastFiredAt === null && !empty.userAlert.status.firingNow && empty.killSwitch.paused.value === false);
    check("recent triggers are capped at 10 newest", recentTriggersFor("r", [summaryWith(Array.from({ length: 15 }, (_, i) => ({ ruleId: "r", dedupeKey: `r:${i}`, at: new Date(Date.UTC(2026, 9, 1 + i)).toISOString() })))]).length === 10);
    const view = composeAlertView("unknown-rule", m.userAlert.enabled, m.userAlert.thresholdUsd, []);
    check("an unknown rule id composes as not live, not firing", !view.status.live && !view.status.firingNow && view.status.recent.length === 0);
    check("the loader reads the seven rows in ONE query (plus names)", state.reads === 1);
  }

  console.log("\n4. mutation: each control enabled / disabled / threshold / restore, ONE audit row per change, ONE transaction");
  {
    const { client, state } = makeDb();
    const r = await applyAiCostControlChanges({ changes: [
      { control: "allowance.enforced", value: false, expectedUpdatedAt: null },
      { control: "allowance.usd", value: 7, expectedUpdatedAt: null },
      { control: "userAlert.enabled", value: false, expectedUpdatedAt: null },
      { control: "userAlert.thresholdUsd", value: 6, expectedUpdatedAt: null },
      { control: "fleetAlert.enabled", value: false, expectedUpdatedAt: null },
      { control: "fleetAlert.thresholdUsd", value: 25, expectedUpdatedAt: null },
      { control: "killSwitch.paused", value: true, expectedUpdatedAt: null },
    ], reason, actor }, client, NOW);
    check("all seven applied in one call", r.ok && state.settings.size === 7);
    if (!r.ok) return;
    check("the model reflects every change with origin SETTING", !r.model.allowance.enforced.value && r.model.allowance.usd.value === 7 && !r.model.userAlert.enabled.value && r.model.userAlert.thresholdUsd.value === 6 && !r.model.fleetAlert.enabled.value && r.model.fleetAlert.thresholdUsd.value === 25 && r.model.killSwitch.paused.value && r.model.killSwitch.paused.origin === "SETTING");
    check("ONE audit row per change (7), PLATFORM_POLICY_CHANGED, by the operator", state.audits.length === 7 && state.audits.every((a) => a.action === AuditAction.PLATFORM_POLICY_CHANGED && a.performedByAdminId === "op1"));
    const a0 = state.audits[1].metadata as { target: { kind: string; id: string }; reason: { code: string; note: string }; change: { before: Record<string, unknown>; after: Record<string, unknown> }; control: string; settingKey: string };
    check("audit row: target PLATFORM_SETTING + key, reason, before { value null, DEFAULT } → after { value '7', SETTING, updatedAt }, detail { control, settingKey }",
      a0.target.kind === "PLATFORM_SETTING" && a0.target.id === K["allowance.usd"] && a0.reason.code === "POLICY_ROLLOUT" && a0.reason.note === reason.note
      && a0.change.before.value === null && a0.change.before.origin === "DEFAULT" && a0.change.after.value === "7" && a0.change.after.origin === "SETTING" && typeof a0.change.after.updatedAt === "string"
      && a0.control === "allowance.usd" && a0.settingKey === K["allowance.usd"]);
    check("no secret-shaped word in any audit row", !/password|token|api[_-]?key|secret/i.test(JSON.stringify(state.audits)));
    check("both policy actions require a reason", REASON_REQUIRED_ACTIONS.has(AuditAction.PLATFORM_POLICY_CHANGED) && REASON_REQUIRED_ACTIONS.has(AuditAction.PLATFORM_POLICY_RESET));

    // Re-enable with the observed versions; a stale version anywhere ⇒ nothing written.
    const v = r.model;
    const again = await applyAiCostControlChanges({ changes: [
      { control: "killSwitch.paused", value: false, expectedUpdatedAt: v.killSwitch.paused.updatedAt },
      { control: "allowance.enforced", value: true, expectedUpdatedAt: v.allowance.enforced.updatedAt },
    ], reason, actor }, client, NOW);
    check("updates with the observed versions succeed (resume + enforce)", again.ok && !again.model.killSwitch.paused.value && again.model.allowance.enforced.value && state.audits.length === 9);

    const stale = await applyAiCostControlChanges({ changes: [
      { control: "userAlert.thresholdUsd", value: 9, expectedUpdatedAt: v.userAlert.thresholdUsd.updatedAt },
      { control: "killSwitch.paused", value: true, expectedUpdatedAt: v.killSwitch.paused.updatedAt },  // moved above
    ], reason, actor }, client, NOW);
    check("a stale version on the SECOND change ⇒ CONFLICT naming it, and the FIRST change is rolled back too (all-or-nothing)",
      !stale.ok && stale.code === "CONFLICT" && stale.control === "killSwitch.paused" && stale.model.userAlert.thresholdUsd.value === 6 && state.audits.length === 9);
    const nullForRow = await applyAiCostControlChanges({ changes: [{ control: "allowance.usd", value: 9, expectedUpdatedAt: null }], reason, actor }, client, NOW);
    check("expectedUpdatedAt null while a row exists ⇒ CONFLICT", !nullForRow.ok && nullForRow.code === "CONFLICT" && state.settings.get(K["allowance.usd"])?.value === "7");

    // Restore defaults: the row is DELETED, origin DEFAULT, PLATFORM_POLICY_RESET audited with after { value null, DEFAULT }.
    const cur = (await loadAiCostControlsReadModel(client, NOW));
    const reset = await applyAiCostControlChanges({ changes: [
      { control: "allowance.usd", value: null, expectedUpdatedAt: cur.allowance.usd.updatedAt },
      { control: "fleetAlert.thresholdUsd", value: null, expectedUpdatedAt: cur.fleetAlert.thresholdUsd.updatedAt },
    ], reason: { code: "TESTING" }, actor }, client, NOW);
    check("reset deletes the rows and the defaults are in force with origin DEFAULT", reset.ok && !state.settings.has(K["allowance.usd"]) && !state.settings.has(K["fleetAlert.thresholdUsd"]) && reset.model.allowance.usd.value === 5 && reset.model.allowance.usd.origin === "DEFAULT" && reset.model.fleetAlert.thresholdUsd.value === 10);
    const last = state.audits[state.audits.length - 1].metadata as { change: { before: Record<string, unknown>; after: Record<string, unknown> } };
    check("reset audit: PLATFORM_POLICY_RESET, before SETTING '25' → after { value null, DEFAULT, updatedAt null }", state.audits[state.audits.length - 1].action === AuditAction.PLATFORM_POLICY_RESET && last.change.before.value === "25" && last.change.after.value === null && last.change.after.origin === "DEFAULT" && last.change.after.updatedAt === null);
    const nothing = await applyAiCostControlChanges({ changes: [{ control: "allowance.usd", value: null, expectedUpdatedAt: null }], reason, actor }, client, NOW);
    check("reset with no row ⇒ NOT_FOUND, nothing written", !nothing.ok && nothing.code === "NOT_FOUND" && nothing.control === "allowance.usd");
    const invalid = await applyAiCostControlChanges({ changes: [{ control: "allowance.usd", value: 21, expectedUpdatedAt: null }], reason, actor }, client, NOW);
    check("above the ceiling ⇒ VALIDATION before any transaction (no audit row)", !invalid.ok && invalid.code === "VALIDATION" && invalid.control === "allowance.usd" && state.audits.length === 11);
    const noReason = await applyAiCostControlChanges({ changes: [{ control: "allowance.usd", value: 4, expectedUpdatedAt: null }], reason: undefined as never, actor }, client, NOW);
    check("no reason ⇒ VALIDATION, nothing written", !noReason.ok && noReason.code === "VALIDATION" && !state.settings.has(K["allowance.usd"]));
  }

  console.log("\n5. a concurrent writer between the read and the write ⇒ CONFLICT, nothing written");
  {
    const { client, state } = makeDb({}, { interleave: (s) => { s.settings.set(K["allowance.usd"], { key: K["allowance.usd"], value: "3", updatedAt: new Date("2026-10-15T11:59:00Z"), updatedById: "other" }); } });
    const r = await applyAiCostControlChanges({ changes: [{ control: "allowance.usd", value: 9, expectedUpdatedAt: null }], reason, actor }, client, NOW);
    check("the race is refused as CONFLICT and the other operator's row stands", !r.ok && r.code === "CONFLICT" && state.settings.get(K["allowance.usd"])?.value === "3" && state.audits.length === 0);
  }

  console.log("\n6. cache freshness — a change is visible to the very next decision (no process cache anywhere)");
  {
    const { client, state } = makeDb();
    const before = (await loadAiCostControlsReadModel(client, NOW)).killSwitch.paused.value;
    state.settings.set(K["killSwitch.paused"], { key: K["killSwitch.paused"], value: "true", updatedAt: NOW, updatedById: null });
    const after = (await loadAiCostControlsReadModel(client, NOW)).killSwitch.paused.value;
    check("the read model reflects a row written by someone else on the next read", before === false && after === true);
    for (const f of ["lib/platform/ai/cost-controls.ts", "lib/platform/ai/paid-requests-admission.ts", "lib/platform/ai/allowance-reservation.ts", "lib/ai/allowance.ts", "lib/entitlements/resolve.ts", "lib/entitlements/consume.ts", "lib/platform/ai/spend-thresholds.ts", "lib/alerts/run.ts"]) {
      check(`${f}: holds no memo / cache / module-level store of a policy read`, !/\bcache\b|memo\(|^(const|let|var)\s+\w+(\s*:[^=]+)?=\s*new (Map|Set|WeakMap)\b|unstable_cache|revalidate/m.test(strip(f).replace(/console\.[a-z]+\([^)]*\)/g, "")), f);
    }
  }

  console.log("\n7. the routes: gates, pacing, shape");
  {
    const route = strip("app/api/platform/platform-ops/ai-cost-controls/route.ts");
    check("GET requires PLATFORM_OPS READ and returns the error first", /requirePlatformAccess\("PLATFORM_OPS", "READ"\)/.test(route) && /if \(err\) return err/.test(route));
    check("PATCH requires FRESH PLATFORM_OPS CONTROL (READ / WRITE holders get 403)", /requireFreshPlatformAccess\("PLATFORM_OPS", "CONTROL"\)/.test(route) && !/"WRITE"/.test(route));
    check("PATCH is paced on the policies bucket", /limitByUser\(auth\.user\.id, "platform-policy"/.test(route));
    check("PATCH parses a structured reason and refuses 400 without one", /parseOperatorReason\(body\.reason\)/.test(route) && /status: 400/.test(route));
    check("the route delegates every rule to the one service and never touches PlatformSetting or AuditLog", /applyAiCostControlChanges\(/.test(route) && !/platformSetting|auditLog|@\/lib\/db/.test(route));
    check("refusals map CONFLICT → 409, NOT_FOUND → 404, else 400, with the model", /"CONFLICT" \? 409/.test(route) && /"NOT_FOUND" \? 404/.test(route) && /model: result\.model/.test(route));
    check("no-store on every response", (route.match(/NO_STORE/g) ?? []).length >= 4);
    const budget = strip("app/api/platform/platform-ops/ai-budget/route.ts");
    check("ai-budget: PLATFORM_OPS READ, no mutating verb, no db import, no-store", /requirePlatformAccess\("PLATFORM_OPS", "READ"\)/.test(budget) && !/export\s+(async\s+)?function\s+(POST|PUT|PATCH|DELETE)/.test(budget) && !/@\/lib\/db/.test(budget) && /no-store/.test(budget));
    const svc = strip("lib/platform/ai/cost-controls.ts");
    check("the service writes only through the registry's conditional primitives and records inside the transaction", /createSettingIfAbsent\(tx/.test(svc) && /updateSettingIfVersion\(tx/.test(svc) && /deleteSettingIfVersion\(tx/.test(svc) && !/platformSetting\.(create|update|upsert|delete|updateMany|deleteMany)\(/.test(svc) && /\$transaction\(async \(tx\) => \{[\s\S]*recordOperatorAction\(tx,/.test(svc));
    check("the service is fm_system, never the migration principal", /import \{ systemDb \} from "@\/lib\/db"/.test(svc) && !/import\s*\{[^}]*\bdb\b[^}]*\}\s*from\s*"@\/lib\/db"/.test(svc));
    const budgetSvc = strip("lib/platform/ai/ai-budget.ts");
    check("the budget reader is fm_system and emits opaque refs only", /systemDb/.test(budgetSvc) && /opaqueUserRef\(/.test(budgetSvc) && !/email/.test(budgetSvc));
  }

  if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log("\nall checks passed");
}
void main();
