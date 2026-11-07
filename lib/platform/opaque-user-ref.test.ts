/**
 * lib/platform/opaque-user-ref.test.ts  (PRIV-ref — the keyed opaque customer reference)
 *
 * The opaque reference every operator surface shows is a keyed digest, defined
 * ONCE (opaque-user-ref.ts), derived from NEXTAUTH_SECRET under a fixed label:
 *
 *   determinism · distinct users ⇒ distinct refs · the SAME user ⇒ the SAME ref
 *   through every caller · no secret ⇒ "customer" (never the raw suffix) ·
 *   domain separation · rotation · server-only, no log, one definition, and no
 *   `userId.slice(` / `user …${` suffix reference anywhere else.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/platform/opaque-user-ref.test.ts
 */

import { createHash, createHmac } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { OPAQUE_USER_REF_LABEL, opaqueDedupeToken, opaqueDedupeTokenWith, opaqueUserRef, opaqueUserRefWith } from "./opaque-user-ref";
import { evaluateAiSpendUserHigh, evaluatePolicyAssignmentInvalid } from "@/lib/alerts/evaluate";
import { ALERT_RULES } from "@/lib/alerts/rules";
import { buildAttention } from "./ops/attention-core";
import { REF_NOT_FOUND, REF_NOT_FOUND_CAPPED, REF_SEARCH_SCAN_CAP, resolveOpaqueRef } from "./customer/customers";
import { OPAQUE_USER_REF_FALLBACK, OPAQUE_USER_REF_TOKEN, opaqueRefOfToken, opaqueRefToken } from "./opaque-user-ref-format";
import { buildAiSpendHealth, type UserSpendGroup } from "./ai/spend-health";
import { loadAiBudgetUtilization } from "./ai/ai-budget";
import { projectCall } from "./ai/budget-calls-core";
import { loadPolicyAssignmentHealth, type PolicyAssignmentReadClient } from "./policy-assignment-health";
import { foldRemovedConnections } from "./connections/removed-connections.core";
import type { CostControlsReadClient } from "./ai/cost-controls";
import { CODE_CATALOGUE } from "@/lib/entitlements/policy-groups";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
process.on("unhandledRejection", (err) => {
  if ((err as { constructor?: { name?: string } })?.constructor?.name === "PrismaClientInitializationError") return;
  console.error("  ✗ unexpected:", err); process.exit(1);
});

const SECRET = "test-opaque-ref-secret-A";
const ROOT = process.cwd();
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const NOW = new Date("2026-10-15T18:00:00.000Z");
const ID_A = "cmz0aaaa1111bbbb2222c3d4e5";
const ID_B = "cmz0aaaa1111bbbb2222c3d4e6"; // differs in the LAST character only

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e.startsWith(".")) continue;
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e) && !/\.test\.tsx?$/.test(e)) out.push(path.relative(ROOT, p));
  }
  return out;
}

async function main() {
  console.log("1. the digest — deterministic, distinct, keyed, domain-separated");
  {
    const a = opaqueUserRefWith(ID_A, SECRET);
    check("format: `user #` + 8 hex", /^user #[0-9a-f]{8}$/.test(a), a);
    check("deterministic: the same id + secret ⇒ the same ref", a === opaqueUserRefWith(ID_A, SECRET) && a === opaqueUserRefWith(ID_A, SECRET));
    check("distinct users ⇒ distinct refs (even a one-character difference at the tail)", a !== opaqueUserRefWith(ID_B, SECRET));
    const many = new Set(Array.from({ length: 2000 }, (_, i) => opaqueUserRefWith(`cmuser${String(i).padStart(8, "0")}`, SECRET)));
    check("2,000 ids ⇒ 2,000 distinct refs", many.size === 2000, String(many.size));
    check("the ref carries no part of the id (no 4+ character run of its tail)", ![4, 5, 6].some((k) => a.includes(ID_A.slice(-k))));
    check("rotation: another secret ⇒ another ref", a !== opaqueUserRefWith(ID_A, "test-opaque-ref-secret-B"));
    const naive = createHmac("sha256", SECRET).update(ID_A).digest("hex").slice(0, 8);
    check("domain-separated: not HMAC(secret, id) — the key is derived under the label", !a.endsWith(naive) && OPAQUE_USER_REF_LABEL === "fm/opaque-user-ref/v1");
    const k = createHmac("sha256", SECRET).update(OPAQUE_USER_REF_LABEL).digest();
    check("and exactly HMAC(HMAC(secret, label), id)[0..8]", a === `user #${createHmac("sha256", k).update(ID_A).digest("hex").slice(0, 8)}`);
  }

  console.log("\n2. fail closed — no secret ⇒ \"customer\", never the raw suffix");
  {
    for (const s of [undefined, null, ""]) check(`secret ${JSON.stringify(s)} ⇒ "customer"`, opaqueUserRefWith(ID_A, s) === OPAQUE_USER_REF_FALLBACK);
    const saved = process.env.NEXTAUTH_SECRET;
    delete process.env.NEXTAUTH_SECRET;
    const r = opaqueUserRef(ID_A);
    check("env-reading form with NEXTAUTH_SECRET unset ⇒ \"customer\", no id fragment", r === "customer" && !r.includes(ID_A.slice(-6)));
    process.env.NEXTAUTH_SECRET = SECRET;
    check("env-reading form reads NEXTAUTH_SECRET at call time", opaqueUserRef(ID_A) === opaqueUserRefWith(ID_A, SECRET));
    if (saved === undefined) process.env.NEXTAUTH_SECRET = SECRET; else process.env.NEXTAUTH_SECRET = saved;
    process.env.NEXTAUTH_SECRET = SECRET;
    check("the format helpers: token round trip; 'customer' / '—' / legacy suffix have no token",
      opaqueRefToken(opaqueRefOfToken("3fa9c21b")) === "3fa9c21b" && opaqueRefToken("customer") === null && opaqueRefToken("—") === null
        && opaqueRefToken("user …abc123") === null && OPAQUE_USER_REF_TOKEN.test("3fa9c21b") && !OPAQUE_USER_REF_TOKEN.test("abc123"));
  }

  console.log("\n3. the SAME user ⇒ the SAME ref through every caller");
  {
    process.env.NEXTAUTH_SECRET = SECRET;
    const want = opaqueUserRefWith(ID_A, SECRET);
    const g = (userId: string, promptM: number): UserSpendGroup => ({ userId, provider: "OPENAI", model: "gpt-5.1", surface: "chat", day: "2026-10-15", invocations: 1, promptTokens: promptM * 1_000_000, cachedPromptTokens: 0, completionTokens: 0 });
    const health = buildAiSpendHealth([g(ID_A, 4), g(ID_B, 1)], { fleetUsd: 10, userUsd: 3 }, 24, NOW);
    const controls: CostControlsReadClient = {
      platformSetting: { findMany: async () => [] }, user: { findMany: async () => [] }, jobRun: { findMany: async () => [] },
      customerPolicyAssignment: { findMany: async () => [], count: async () => 0 },
    };
    const budget = await loadAiBudgetUtilization({ now: NOW, loadCatalogue: async () => CODE_CATALOGUE, groups: async () => [g(ID_A, 4), g(ID_B, 1)], controls, assignments: { customerPolicyAssignment: { findMany: async () => [] } } });
    const call = projectCall({ id: "inv1", occurredAt: NOW, provider: "OPENAI", model: "gpt-5.1", surface: "chat", outcome: "RETURNED", errorCode: null, promptTokens: 10, cachedPromptTokens: 0, completionTokens: 1, userId: ID_A }, opaqueUserRef);
    const client: PolicyAssignmentReadClient = {
      user: { count: async () => 1, findMany: async () => [{ id: ID_A, createdAt: NOW }] },
      customerPolicyAssignment: { count: async () => 0, findMany: async () => [] },
    };
    const assign = await loadPolicyAssignmentHealth({ client, enforced: true, now: NOW, catalogue: CODE_CATALOGUE });
    const removed = foldRemovedConnections({
      plaidItems: [{ id: "p1", userId: ID_A, institutionName: "Bank", status: "REVOKED", deletedAt: NOW, updatedAt: NOW, links: [] }] as never,
      wallets: [], markers: [], revokedTransitions: [], customerActs: [], operatorActs: [], operatorLabel: () => null, refOf: opaqueUserRef, now: NOW,
    } as never);
    const got = {
      "spend-health maxUserRef": health.maxUserRef,
      "ai-budget customer ref": budget.customers.find((c) => c.rolling24hUsd > 4)?.ref ?? null,
      "budget-calls row ref": call.customerRef,
      "policy-assignment ref": assign.items[0]?.ref ?? null,
      "removed-connections ownerRef": removed[0]?.ownerRef ?? null,
    };
    check("every caller names the same customer identically", Object.values(got).every((v) => v === want), JSON.stringify(got));
    const SOURCES: [string, RegExp][] = [
      ["lib/platform/ai/cost-controls.ts", /opaqueUserRef\(r\.userId\)/],
      ["lib/platform/connection-diagnostics.ts", /opaqueUserRef\(userId\)/],
      ["lib/platform/plaid/provider-cleanup.ts", /opaqueUserRef\(row\.userId\)/],
      ["lib/platform/connections/removed-connections.ts", /refOf:\s*opaqueUserRef/],
      ["lib/platform/policy-assignment-health.ts", /refOf:\s*opaqueUserRef/],
      ["lib/platform/ai/budget-calls.ts", /projectCall\(r,\s*opaqueUserRef\)/],
    ];
    for (const [f, re] of SOURCES) {
      const src = strip(readFileSync(path.join(ROOT, f), "utf8"));
      check(`${f}: uses THE ref, imported from lib/platform/opaque-user-ref`, re.test(src) && /from "@\/lib\/platform\/opaque-user-ref"/.test(src));
    }
  }

  console.log("\n3b. dedupe tokens — keyed, distinct per customer even with NO secret (never a suppressed breach)");
  {
    check("with the secret, the dedupe token is the ref's own 8 hex (same K)", opaqueDedupeTokenWith(ID_A, SECRET) === opaqueRefToken(opaqueUserRefWith(ID_A, SECRET)));
    const a0 = opaqueDedupeTokenWith(ID_A, undefined), b0 = opaqueDedupeTokenWith(ID_B, undefined);
    check("no secret: two users ⇒ two different dedupe tokens", a0 !== b0 && /^[0-9a-f]{8}$/.test(a0) && /^[0-9a-f]{8}$/.test(b0), `${a0} ${b0}`);
    check("no secret: stable within the process (one key per instance)", a0 === opaqueDedupeTokenWith(ID_A, ""));
    check("no secret: never \"customer\", never an id fragment, never unkeyed SHA-256 or the session-keyed form",
      a0 !== "customer" && ![4, 5, 6].some((k) => a0.includes(ID_A.slice(-k)))
        && a0 !== createHmac("sha256", "").update(ID_A).digest("hex").slice(0, 8)
        && !createHash("sha256").update(ID_A).digest("hex").startsWith(a0)
        && a0 !== opaqueDedupeTokenWith(ID_A, SECRET));

    // End to end with the secret ABSENT: refs collapse to "customer", dedupe keys do not.
    const saved = process.env.NEXTAUTH_SECRET;
    delete process.env.NEXTAUTH_SECRET;
    try {
      const userRule = ALERT_RULES.find((r) => r.id === "ai-spend-user-high")!;
      const g = (userId: string): UserSpendGroup => ({ userId, provider: "OPENAI", model: "gpt-5.1", surface: "chat", day: "2026-10-15", invocations: 1, promptTokens: 4_000_000, cachedPromptTokens: 0, completionTokens: 0 });
      const hA = buildAiSpendHealth([g(ID_A)], { fleetUsd: 100, userUsd: 3 }, 24, NOW);
      const hB = buildAiSpendHealth([g(ID_B)], { fleetUsd: 100, userUsd: 3 }, 24, NOW);
      const kA = evaluateAiSpendUserHigh(userRule, hA)[0]?.dedupeKey, kB = evaluateAiSpendUserHigh(userRule, hB)[0]?.dedupeKey;
      check("no secret: both refs read \"customer\"", hA.maxUserRef === "customer" && hB.maxUserRef === "customer");
      check("PIN: no secret ⇒ two customers' spend breaches get two DIFFERENT dedupe keys", !!kA && !!kB && kA !== kB && !kA.endsWith(":customer"), `${kA} ${kB}`);

      const client: PolicyAssignmentReadClient = {
        user: { count: async () => 2, findMany: async () => [{ id: ID_A, createdAt: NOW }, { id: ID_B, createdAt: NOW }] },
        customerPolicyAssignment: { count: async () => 0, findMany: async () => [] },
      };
      const assign = await loadPolicyAssignmentHealth({ client, enforced: true, now: NOW, catalogue: CODE_CATALOGUE });
      const sig = evaluatePolicyAssignmentInvalid(ALERT_RULES.find((r) => r.id === "policy-assignment-invalid")!, assign).filter((x) => !x.dedupeKey.endsWith(":unlisted"));
      check("PIN: no secret ⇒ two customers' assignment breaches get two DIFFERENT dedupe keys", sig.length === 2 && sig[0].dedupeKey !== sig[1].dedupeKey && sig.every((x) => !x.dedupeKey.endsWith(":customer")), sig.map((x) => x.dedupeKey).join(" "));
      const att = buildAttention({ connections: null, jobs: null, providers: null, resources: null, alerts: null, incidents: null, policyAssignments: assign }, NOW);
      const ids = att.items.filter((i) => i.entity.kind === "customer").map((i) => i.id);
      check("no secret ⇒ Attention row ids stay distinct (labels both \"customer\")", ids.length === 2 && new Set(ids).size === 2 && att.items.filter((i) => i.entity.kind === "customer").every((i) => i.entity.label === "customer"));
      check("dedupe keys carry no raw id", ![kA, kB, ...sig.map((x) => x.dedupeKey), ...ids].some((k) => (k ?? "").includes(ID_A) || (k ?? "").includes(ID_A.slice(-6)) || (k ?? "").includes(ID_B.slice(-6))));
    } finally {
      if (saved === undefined) process.env.NEXTAUTH_SECRET = SECRET; else process.env.NEXTAUTH_SECRET = saved;
    }
    const ev = strip(readFileSync(path.join(ROOT, "lib/alerts/evaluate.ts"), "utf8"));
    const ac = strip(readFileSync(path.join(ROOT, "lib/platform/ops/attention-core.ts"), "utf8"));
    check("every alert dedupe key / Attention id that used the token now uses the dedupe token",
      /spend\.maxUserDedupe/.test(ev) && /\$\{i\.dedupe\}/.test(ev) && /\$\{i\.dedupe\}/.test(ac) && !/i\.ref\.slice|maxUserRef\.slice/.test(ev + ac));
    check("the env-reading dedupe token reads NEXTAUTH_SECRET at call time", opaqueDedupeToken(ID_A) === opaqueDedupeTokenWith(ID_A, process.env.NEXTAUTH_SECRET));
  }

  console.log("\n3c. Customer Success reverse lookup — every match, loud when not found, rate-limited, unaudited");
  {
    const fake = (ids: string[]) => ({ user: { findMany: async (a: { take: number }) => ids.slice(0, a.take).map((id) => ({ id })) } });
    // A forced 32-bit collision: two ids digest to the same reference.
    const collide = (id: string) => (id === "u1" || id === "u3" ? "user #0000beef" : `user #${id.padStart(8, "f").slice(-8)}`);
    const both = await resolveOpaqueRef("0000beef", fake(["u1", "u2", "u3", "u4"]), collide);
    check("a colliding reference returns ALL matching accounts, never only the first", JSON.stringify(both.ids) === JSON.stringify(["u1", "u3"]) && both.search.matches === 2 && both.search.note === null);
    const real = await resolveOpaqueRef(opaqueRefToken(opaqueUserRefWith(ID_B, SECRET))!, fake([ID_A, ID_B]), (id) => opaqueUserRefWith(id, SECRET));
    check("the real digest resolves the right account", JSON.stringify(real.ids) === JSON.stringify([ID_B]));
    const miss = await resolveOpaqueRef("deadbeef", fake(["u1", "u2"]), collide);
    check("not found, scan not capped ⇒ the plain not-found line (never silent)", miss.ids.length === 0 && miss.search.note === REF_NOT_FOUND && !miss.search.capped);
    const big = Array.from({ length: REF_SEARCH_SCAN_CAP + 10 }, (_, i) => `id${i}`);
    const capped = await resolveOpaqueRef("deadbeef", fake(big), collide);
    check("not found at the cap ⇒ the capped line, naming the 5,000", capped.search.capped && capped.search.scanned === REF_SEARCH_SCAN_CAP
      && capped.search.note === "Reference not found among the newest 5,000 accounts — it may belong to an older account" && capped.search.note === REF_NOT_FOUND_CAPPED);
    const route = strip(readFileSync(path.join(ROOT, "app/api/platform/customer-success/customers/route.ts"), "utf8"));
    check("the CS list route is rate-limited per operator, with a tighter bucket for reference lookups",
      /limitByUser\(auth\.user\.id,\s*"cs-customers-list"/.test(route) && /limitByUser\(auth\.user\.id,\s*"cs-customers-ref-lookup"/.test(route)
        && route.indexOf("cs-customers-list") < route.indexOf("listCustomers("));
    const cs = strip(readFileSync(path.join(ROOT, "lib/platform/customer/customers.ts"), "utf8"));
    check("the lookup writes no audit row (no audit write in the list reader)", !/recordAudit|writeAudit|auditLog\.create|logAudit/.test(cs));
    const widget = strip(readFileSync(path.join(ROOT, "components/platform/widgets/CsCustomersWidget.tsx"), "utf8"));
    check("the CS list shows the not-found line and a collision line", /refSearch\?\.note/.test(widget) && /data-ref-search-note/.test(widget) && /data-ref-search-collision/.test(widget));
  }

  console.log("\n4. pins — one definition, server-only, no log, no suffix reference anywhere else");
  {
    const files = [...walk(path.join(ROOT, "lib")), ...walk(path.join(ROOT, "app")), ...walk(path.join(ROOT, "components")), ...walk(path.join(ROOT, "jobs"))];
    const src = (f: string) => strip(readFileSync(path.join(ROOT, f), "utf8"));
    const defs = files.filter((f) => /export\s+function\s+opaqueUserRef\s*\(/.test(src(f)));
    check("ONE definition of opaqueUserRef (lib/platform/opaque-user-ref.ts)", defs.length === 1 && defs[0] === "lib/platform/opaque-user-ref.ts", defs.join(", "));
    const labels = files.filter((f) => src(f).includes("fm/opaque-user-ref/"));
    check("the derivation label lives in that one file", labels.length === 1 && labels[0] === "lib/platform/opaque-user-ref.ts", labels.join(", "));
    const slicers = files.filter((f) => /\b[uU]serId\??\.slice\(/.test(src(f)));
    check("no `userId.slice(` anywhere (no id-tail reference of a customer)", slicers.length === 0, slicers.join(", "));
    // The remaining `user …${…}` templates name STAFF (operator / author labels) or are the
    // Customer Success identity fallback (CS may see identity). A closed list: a new one fails here.
    const ALLOWED_STAFF_OR_CS = [
      "lib/platform/connections/removed-connections.core.ts",   // the OPERATOR who removed a connection (staff)
      "lib/platform/customer/identity-label.ts",                // Customer Success identity label fallback
      "lib/platform/policies/policy-group-detail.ts",           // the staff author of a policy version
      "lib/platform/policies/policy-group-lifecycle-read.ts",   // the staff operator of a lifecycle transition
    ].sort();
    const tails = files.filter((f) => /user …\$\{/.test(src(f))).sort();
    check("`user …${…}` appears only in the closed staff / CS list", JSON.stringify(tails) === JSON.stringify(ALLOWED_STAFF_OR_CS), tails.join(", "));
    const mod = readFileSync(path.join(ROOT, "lib/platform/opaque-user-ref.ts"), "utf8");
    check("the module is server-only", /^import "server-only";$/m.test(mod));
    check("the module logs nothing (no console, no logger)", !/console\.|logger|log\(/.test(strip(mod)));
    check("the module reads NEXTAUTH_SECRET and adds no new env var", (strip(mod).match(/process\.env\.[A-Z_]+/g) ?? []).every((v) => v === "process.env.NEXTAUTH_SECRET"));
    const fmt = strip(readFileSync(path.join(ROOT, "lib/platform/opaque-user-ref-format.ts"), "utf8"));
    check("the client-safe format module holds no crypto and no secret", !/crypto|process\.env|createHmac/.test(fmt));
    const clientImporters = files.filter((f) => /^\s*["']use client["']/m.test(readFileSync(path.join(ROOT, f), "utf8")) && /lib\/platform\/opaque-user-ref["']/.test(src(f)));
    check("no client component imports the keyed module", clientImporters.length === 0, clientImporters.join(", "));
    const cores = ["lib/entitlements/assignment-health-core.ts", "lib/platform/connections/removed-connections.core.ts"];
    check("the client-reachable pure cores take the ref by injection, never import the keyed module", cores.every((f) => !/opaque-user-ref["']/.test(src(f)) && /refOf/.test(src(f))));
  }

  if (failures > 0) { console.error(`\nopaque-user-ref: ${failures} check(s) failed.`); process.exit(1); }
  console.log("\nopaque-user-ref: all checks passed.");
}

void main();
