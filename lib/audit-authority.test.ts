/**
 * lib/audit-authority.test.ts — V25-CLOSE-3 Part 4
 *
 * Pins the audit-authority decision so it cannot silently regress into ambiguity.
 *
 *     npx tsx lib/audit-authority.test.ts
 *
 * DECISION: `buildAuditData` is the one audit-shape authority (pure, consumed by
 * lib/auth.ts, pinned by lib/security-surface.test.ts). The thin `recordAuditEvent`
 * adapter — which had ZERO production callers — was REMOVED rather than promoted:
 * full promotion means migrating every direct writer, an architecture migration
 * out of scope for an honesty slice; and per the project's rule (never ship an
 * authority without a consumer) an unadopted adapter is worse than none. This
 * guard fails if `recordAuditEvent` is reintroduced without a real consumer, so
 * the "adopt or delete, never a half state" outcome stays true.
 */

import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { buildAuditData } from "@/lib/audit";

const ROOT = process.cwd();

let failures = 0;
let passes = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) { passes++; }
  else { failures++; console.log(`[FAIL] ${name}`); if (detail) console.log(`        ${detail}`); }
}
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");
}
function walk(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".next" || e.name === "prototype") continue;
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) walk(rel, acc);
    else if (/\.tsx?$/.test(e.name)) acc.push(rel);
  }
  return acc;
}

// ── The kept authority works and is genuinely used ────────────────────────────

check("buildAuditData is exported and callable", typeof buildAuditData === "function");
{
  const row = buildAuditData({ actorType: "SYSTEM_ADMIN", action: "LOGIN", result: "SUCCESS" });
  const md = row.metadata as unknown as Record<string, unknown>;
  check(
    "buildAuditData folds actorType/result into metadata",
    md.actorType === "SYSTEM_ADMIN" && md.result === "SUCCESS",
  );
}

const auditSrc = stripComments(readFileSync(join(ROOT, "lib/audit.ts"), "utf8"));

// ── The removed adapter must not return without a consumer ────────────────────

const files = [...walk("lib"), ...walk("app")].filter((f) => !f.endsWith(".test.ts") && !f.endsWith(".test.tsx"));
const recordAuditRefs = files.filter((f) =>
  stripComments(readFileSync(join(ROOT, f), "utf8")).includes("recordAuditEvent"),
);

check(
  "recordAuditEvent is not defined in lib/audit.ts",
  !/export\s+(async\s+)?function\s+recordAuditEvent/.test(auditSrc),
  "the zero-consumer adapter is back — either give it real consumers or keep it deleted",
);

check(
  "no production code references recordAuditEvent",
  recordAuditRefs.length === 0,
  `referenced by: ${recordAuditRefs.join(", ")}`,
);

// ── buildAuditData is not itself orphaned (the decision keeps a CONSUMED authority) ──

const buildAuditConsumers = files.filter(
  (f) => f !== "lib/audit.ts" && stripComments(readFileSync(join(ROOT, f), "utf8")).includes("buildAuditData"),
);
check(
  "buildAuditData has at least one production consumer",
  buildAuditConsumers.length >= 1,
  "if buildAuditData loses all consumers it becomes the same anti-pattern — reassess the decision",
);

console.log(`\naudit-authority: ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
