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

import { createHmac } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { OPAQUE_USER_REF_LABEL, opaqueUserRef, opaqueUserRefWith } from "./opaque-user-ref";
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
