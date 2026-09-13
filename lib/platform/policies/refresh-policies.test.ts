/**
 * lib/platform/policies/refresh-policies.test.ts  (PLATFORM OPS POLICIES — Slice 1)
 *
 * THE POLICIES READ MODEL: DESIRED, EFFECTIVE, CAPABILITY, ACTUAL — apart.
 *
 *   npx tsx lib/platform/policies/refresh-policies.test.ts
 *
 * Pure composition over fixtures with the REAL registry's capability, plus the
 * loader against a fake client (no database) and a source scan for the
 * read-only / no-provider-call / no-PII contract.
 */

import { readFileSync } from "node:fs";
import { SCHEDULED_JOBS } from "@/lib/jobs/registry";
import { schedulerCapability } from "@/lib/platform/scheduler-capability";
import { resolveRefreshPolicy } from "@/lib/platform/refresh-policy.core";
import { composeRefreshPolicyView, type ComposeRefreshPolicyInput } from "./refresh-policies.core";
import { loadRefreshPoliciesReadModel } from "./refresh-policies";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const NOW = new Date("2026-09-14T12:00:00.000Z");
const AT = new Date("2026-09-14T06:00:05.000Z");
const wallet = (over: Partial<ComposeRefreshPolicyInput> = {}): ComposeRefreshPolicyInput => ({
  sourceKind: "WALLET", label: "Wallet refresh", description: "d", row: null, updatedByName: null,
  capability: schedulerCapability("WALLET", SCHEDULED_JOBS), evidence: null, ...over,
});
const bank = (over: Partial<ComposeRefreshPolicyInput> = {}): ComposeRefreshPolicyInput => ({
  sourceKind: "BANK", label: "Bank refresh", description: "d", row: null, updatedByName: null,
  capability: schedulerCapability("BANK", SCHEDULED_JOBS), evidence: null, ...over,
});
const row = (value: string, at = "2026-09-13T18:32:00.000Z", by: string | null = "user_1") => ({ value, updatedAt: new Date(at), updatedById: by });

async function main(): Promise<void> {
  console.log("A. no setting row → DEFAULT");
  {
    const v = composeRefreshPolicyView(wallet());
    check("desired: absent", !v.desired.present && v.desired.raw === null && v.desired.updatedAt === null && v.desired.updatedBy === null);
    check("effective: 6h, overdue after 8h, origin DEFAULT", v.effective.cadence === "6h" && v.effective.overdueAfterHours === 8 && v.effective.origin === "DEFAULT");
    check("no mismatch", v.mismatch === null);
    const b = composeRefreshPolicyView(bank());
    check("bank default: 24h, overdue after 30h, origin DEFAULT", b.effective.cadence === "24h" && b.effective.overdueAfterHours === 30 && b.effective.origin === "DEFAULT");
  }

  console.log("\nB. valid override → SETTING");
  {
    const v = composeRefreshPolicyView(wallet({ row: row("12h"), updatedByName: "Chris" }));
    check("desired carries the raw value, the clock and the writer's name (never an email)",
      v.desired.present && v.desired.raw === "12h" && v.desired.updatedAt === "2026-09-13T18:32:00.000Z" && v.desired.updatedBy?.name === "Chris" && !/@/.test(JSON.stringify(v)));
    check("effective: 12h, overdue after 15h, origin SETTING", v.effective.cadence === "12h" && v.effective.overdueAfterHours === 15 && v.effective.origin === "SETTING");
    check("the version is the resolver's (moves with the row)", v.effective.version === resolveRefreshPolicy({ sourceKind: "WALLET" }, row("12h")).version);
    check("no mismatch", v.mismatch === null);
  }

  console.log("\nC. invalid override → INVALID_SETTING, default in force, override still observable");
  {
    const v = composeRefreshPolicyView(wallet({ row: row("every 5 minutes") }));
    check("desired is PRESENT with the unreadable raw value", v.desired.present && v.desired.raw === "every 5 minutes");
    check("effective is the DEFAULT with origin INVALID_SETTING", v.effective.cadence === "6h" && v.effective.origin === "INVALID_SETTING");
    check("mismatch names the invalid override and the default in force",
      v.mismatch?.kind === "INVALID_OVERRIDE" && /unreadable/.test(v.mismatch.message) && /6 hours/.test(v.mismatch.message));
    check("the read model does not claim the default was configured", v.effective.origin !== "SETTING" && v.effective.origin !== "DEFAULT");
  }

  console.log("\nD/E. capability: supported vs unsupported");
  {
    const six = composeRefreshPolicyView(wallet());
    check("D. 6h wallet policy is honoured by the deployed schedule", six.capability.effectiveHonoured && six.capability.honourable.join(",") === "6h,12h,24h");
    const eight = composeRefreshPolicyView(wallet({ row: row("8h") }));
    check("E. an 8h override (legacy row) is effective but NOT honoured, with the reason",
      eight.effective.cadence === "8h" && !eight.capability.effectiveHonoured && eight.mismatch?.kind === "UNHONOURABLE_EFFECTIVE" && /12 hours/.test(eight.mismatch.message));
    check("E. unsupported options carry reasons; supported ones carry none",
      six.capability.options.every((o) => (o.honourable ? o.reason === null : typeof o.reason === "string" && o.reason.length > 0)));
    const b = composeRefreshPolicyView(bank());
    check("bank: only 24h is available; 4h/6h/8h/12h unsupported", b.capability.honourable.join(",") === "24h" && b.capability.options.filter((o) => !o.honourable).length === 4);
  }

  console.log("\nF/G/H. actual: UNKNOWN / CURRENT / PENDING");
  {
    const none = composeRefreshPolicyView(wallet());
    check("F. no execution evidence → UNKNOWN, naming the job it waited for", none.actual.state === "UNKNOWN" && /sync-crypto/.test(none.actual.note) && none.actual.observedAt === null);
    const current = composeRefreshPolicyView(wallet({ evidence: { job: "sync-crypto", startedAt: AT, policyVersion: resolveRefreshPolicy({ sourceKind: "WALLET" }, null).version } }));
    check("G. latest sweep stamped the current version → CURRENT", current.actual.state === "CURRENT" && current.actual.observedAt === AT.toISOString() && current.actual.job === "sync-crypto");
    const pending = composeRefreshPolicyView(wallet({ row: row("12h"), evidence: { job: "sync-crypto-continuation", startedAt: AT, policyVersion: "WALLET:6h:default" } }));
    check("H. policy changed after the latest sweep → PENDING, current applies at the next attempt",
      pending.actual.state === "PENDING" && /next scheduled attempt/.test(pending.actual.note) && pending.actual.observedVersion === "WALLET:6h:default");
    const bankRun = composeRefreshPolicyView(bank({ evidence: { job: "sync-banks", startedAt: AT, policyVersion: null } }));
    check("bank: a run that recorded no version is UNKNOWN, not fabricated", bankRun.actual.state === "UNKNOWN" && /no policy version/.test(bankRun.actual.note) && bankRun.actual.observedAt === AT.toISOString());
  }

  console.log("\nI. updatedAt (the future concurrency token) only where an override exists");
  {
    check("absent row → no updatedAt", composeRefreshPolicyView(wallet()).desired.updatedAt === null);
    check("present row → its updatedAt", composeRefreshPolicyView(wallet({ row: row("6h", "2026-09-01T00:00:00.000Z") })).desired.updatedAt === "2026-09-01T00:00:00.000Z");
    check("present row without a writer → no updatedBy", composeRefreshPolicyView(wallet({ row: row("6h", "2026-09-01T00:00:00.000Z", null) })).desired.updatedBy === null);
  }

  console.log("\nJ. the loader: few reads, no provider, no PII; the route and widget are read-only");
  {
    const calls: string[] = [];
    const client = {
      platformSetting: { findMany: async () => { calls.push("platformSetting.findMany"); return [{ key: "refresh_cadence_wallet", value: "12h", updatedAt: new Date("2026-09-13T18:32:00.000Z"), updatedById: "user_1" }]; } },
      user: { findMany: async () => { calls.push("user.findMany"); return [{ id: "user_1", name: "Chris" }]; } },
      jobRun: { findFirst: async (args: { where: { jobName: { in: string[] } } }) => {
        calls.push(`jobRun.findFirst:${args.where.jobName.in.join("+")}`);
        return args.where.jobName.in.includes("sync-crypto")
          ? { jobName: "sync-crypto", startedAt: AT, summary: { policy: { version: "WALLET:6h:default" } } }
          : { jobName: "sync-banks", startedAt: AT, summary: { succeeded: 3 } };
      } },
    };
    const model = await loadRefreshPoliciesReadModel(client as never, NOW);
    check("four reads: settings, writers, one ledger read per source family",
      calls.length === 4 && calls[0] === "platformSetting.findMany" && calls.filter((c) => c.startsWith("jobRun")).length === 2, calls.join(" | "));
    check("the wallet family read names both the primary and its continuation", calls.some((c) => c === "jobRun.findFirst:sync-crypto+sync-crypto-continuation"));
    const w = model.policies.find((p) => p.sourceKind === "WALLET")!;
    const b = model.policies.find((p) => p.sourceKind === "BANK")!;
    check("wallet: override 12h SETTING, sweep PENDING, writer resolved by name", w.effective.origin === "SETTING" && w.actual.state === "PENDING" && w.desired.updatedBy?.name === "Chris");
    check("bank: DEFAULT, actual UNKNOWN (no version recorded)", b.effective.origin === "DEFAULT" && b.actual.state === "UNKNOWN");
    check("grace stated once (2h floor, 25%)", model.grace.floorHours === 2 && model.grace.share === 0.25);
    const json = JSON.stringify(model);
    check("no email, token, balance or account name in the response", !/@|token|secret|balance|accountName/i.test(json));

    const unreadable = { ...client, platformSetting: { findMany: async () => { throw new Error("relation missing"); } } };
    const fallback = await loadRefreshPoliciesReadModel(unreadable as never, NOW);
    check("an unreadable settings table renders the defaults, never a crash", fallback.policies.every((p) => p.effective.origin === "DEFAULT"));

    const code = (p: string) => readFileSync(p, "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");
    const loader = code("lib/platform/policies/refresh-policies.ts");
    const route = code("app/api/platform/platform-ops/policies/route.ts");
    check("the loader touches no provider, job runner, or AI client",
      !/plaid|rpc|openai|generate|syncWallet|runJob|fetch\(/i.test(loader));
    check("the loader selects no email", !/email/.test(loader));
    check("the route is READ-gated and has no mutating handler",
      /requirePlatformAccess\("PLATFORM_OPS", "READ"\)/.test(route) && !/export async function (PUT|POST|PATCH|DELETE)/.test(route));
    check("the read model is composed at read time, never persisted", !/\.(create|upsert|update|delete)\(/.test(loader + code("lib/platform/policies/refresh-policies.core.ts")));
    const widget = code("components/platform/widgets/OpsPoliciesWidget.tsx");
    check("the widget renders no control (no select, input, button, form, or handler)",
      !/<select|<input|<button|<form|onClick|onChange|onSubmit/.test(widget));
    check("the widget fetches only the policies route", (widget.match(/\/api\/platform\/platform-ops\/[a-z-]+/g) ?? []).every((u) => u === "/api/platform/platform-ops/policies"));
  }

  console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
