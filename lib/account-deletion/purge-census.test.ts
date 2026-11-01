/**
 * lib/account-deletion/purge-census.test.ts  (TEST-009 — the deletion half)
 *
 * THE TABLE CENSUS. Parses prisma/schema.prisma, enumerates every model column
 * that names a User — a foreign key to User, or a soft reference whose name
 * says "user id" / "by id" with no relation — and asserts that the purge
 * handles each one by exactly one of:
 *
 *   CASCADE    the FK is onDelete: Cascade — the row dies with the User;
 *   SETNULL    the FK is onDelete: SetNull — the row survives anonymised
 *              (the column is a cuid, not PII; retained on purpose);
 *   EXPLICIT   lib/account-deletion/purge.ts names the model's delegate AND
 *              the column (an explicit delete or scrub step);
 *   RETAINED   documented below with the reason (operator-identity columns on
 *              someone else's record, and soft references that die with their
 *              parent row through a cascade the purge already triggers).
 *
 * An unclassified (model, column) pair fails the build: a new user-keyed
 * column must be sorted into one of these buckets ON PURPOSE, which is the
 * whole point — PRIV-001 was a Space that nobody had sorted.
 *
 * Standalone tsx (house pattern):
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/account-deletion/purge-census.test.ts
 */

import { readFileSync } from "node:fs";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

// ── Documented retentions (model.column → why) ───────────────────────────────
//
// Every entry here is a DECISION, not an omission. Two shapes qualify:
//   · the column names the user as an ACTOR on a record that belongs to
//     someone else (who revoked / decided / granted) — a cuid with no PII once
//     the User row is gone, kept for the other party's audit trail;
//   · the column is a soft reference on a row that the purge already deletes
//     through a parent cascade (a Space, a FinancialAccount) so there is
//     nothing left to scrub once the transaction commits.
const RETAINED: Record<string, string> = {
  "UserSession.revokedById":          "admin who revoked someone's session — actor identity on another user's record; the subject's own sessions cascade",
  "SpaceMember.revokedById":          "actor identity on another member's row; the subject's own memberships cascade (FK) and sole-member Spaces are deleted",
  "BetaAccessRequest.decidedById":    "operator who decided a waitlist request — actor identity; the subject's OWN request is deleted by e-mail (DB-002 scrub)",
  "BetaAccessRequest.redeemedUserId": "soft ref from the request to the account it minted — the subject's own request row is deleted by e-mail (DB-002 scrub)",
  "User.preferredSpaceId":            "a column ON the User row itself; dies with the row",
  "MerchantRule.spaceId":             "not a user column (listed because the census is conservative about `Id` suffixes): Space-scoped rules die with the Space; USER-scoped rules are deleted by ownerUserId",
  "CustomerPolicyAssignment.assignedById": "Customer Success operator who assigned a policy — actor identity; the subject's own assignment row cascades (FK userId)",
  "CustomerCohort.assignedById":          "operator who created the cohort — actor identity on a platform record",
  // POLICY EDITOR — the operator who created a policy group / wrote a version:
  // actor identity on a deployment-wide configuration record (no customer data);
  // versions are immutable history, so the soft reference is kept like an audit actor.
  "PolicyGroup.createdById":              "operator who created a policy group — actor identity on a platform configuration record",
  "PolicyGroupVersion.createdById":       "operator who wrote an immutable policy-group version — actor identity on platform configuration history",
  // COMMS CENTER B1 — the operator who wrote an immutable notification content version /
  // asked for an AI suggestion: actor identity on deployment-wide copy history (no customer data).
  "CommsTemplateVersion.createdById":     "operator who wrote an immutable notification content version — actor identity on platform copy history",
  "CommsAiSuggestion.requestedById":      "operator who requested an AI authoring suggestion — actor identity on the authoring audit trail",
  // COMMS CENTER B2 — the operators who created / last edited / owner-approved an
  // automation: actor identity on a platform rule (no customer data; the rule is kept for audit).
  "AutomationDefinition.createdById":       "operator who created a comms automation — actor identity on a platform rule",
  "AutomationDefinition.updatedById":       "operator who last edited a comms automation — actor identity on a platform rule",
  "AutomationDefinition.ownerApprovedById": "the owner (SYSTEM_ADMIN) who approved a comms automation version — actor identity on a platform rule",
  "AiInvocation.spaceId":             "not a user column: a soft Space reference on a ledger that survives by design (RLS migration §4); the user column is nulled",
};

// ── Parse the schema ─────────────────────────────────────────────────────────

const schema = readFileSync("prisma/schema.prisma", "utf8");
const purge = readFileSync("lib/account-deletion/purge.ts", "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

interface UserColumn { model: string; column: string; kind: "FK" | "SOFT"; onDelete: string | null }

const models = [...schema.matchAll(/^model (\w+) \{\n([\s\S]*?)\n\}/gm)];
check("the schema parser found a realistic number of models", models.length >= 60, `${models.length}`);

const columns: UserColumn[] = [];
for (const [, model, body] of models) {
  const lines = body.split("\n").map((l) => l.replace(/\/\/.*$/, "").trim()).filter(Boolean);
  const fkColumns = new Map<string, string>(); // column → onDelete
  for (const l of lines) {
    const rel = l.match(/^(\w+)\s+User\??\s+@relation\(([^)]*)\)/);
    if (!rel) continue;
    const fields = rel[2].match(/fields:\s*\[([^\]]*)\]/)?.[1].split(",").map((f) => f.trim()).filter(Boolean) ?? [];
    const onDelete = rel[2].match(/onDelete:\s*(\w+)/)?.[1] ?? "NoAction";
    for (const f of fields) fkColumns.set(f, onDelete);
  }
  for (const l of lines) {
    const scalar = l.match(/^(\w+)\s+String\??(\s|$)/);
    if (!scalar) continue;
    const name = scalar[1];
    if (fkColumns.has(name)) { columns.push({ model, column: name, kind: "FK", onDelete: fkColumns.get(name)! }); continue; }
    // `supersededById` names another ROW of the same table (a supersession
    // chain), never a user — excluded by name.
    if (/(userId|UserId|ById|SpaceId|spaceId)$/.test(name) && !/supersededById$/.test(name) && model !== "Space") {
      columns.push({ model, column: name, kind: "SOFT", onDelete: null });
    }
  }
}
check("the census found User FKs and soft references", columns.filter((c) => c.kind === "FK").length >= 20 && columns.some((c) => c.kind === "SOFT"),
  `${columns.length} columns`);

// ── Classify ─────────────────────────────────────────────────────────────────

const lowerFirst = (s: string) => s[0].toLowerCase() + s.slice(1);
function explicit(c: UserColumn): boolean {
  const delegate = lowerFirst(c.model);
  const touches = new RegExp(`\\b(tx|client)\\.${delegate}\\.(deleteMany|updateMany|delete|update)\\(`);
  return touches.test(purge) && new RegExp(`\\b${c.column}\\b`).test(purge);
}

const unclassified: string[] = [];
const summary: Record<string, string[]> = { CASCADE: [], SETNULL: [], EXPLICIT: [], RETAINED: [], SPACE_CASCADE: [] };
for (const c of columns) {
  const key = `${c.model}.${c.column}`;
  if (c.kind === "FK" && c.onDelete === "Cascade") { summary.CASCADE.push(key); continue; }
  if (c.kind === "FK" && c.onDelete === "SetNull") {
    // FinancialAccount.ownerUserId is SetNull at the FK but the purge deletes
    // the rows explicitly — count it as EXPLICIT so a future removal of that
    // step is visible, not absorbed by the FK classification.
    if (explicit(c)) summary.EXPLICIT.push(key); else summary.SETNULL.push(key);
    continue;
  }
  if (c.kind === "FK") { unclassified.push(`${key} (onDelete ${c.onDelete})`); continue; }
  // Soft references.
  if (explicit(c)) { summary.EXPLICIT.push(key); continue; }
  if (RETAINED[key]) { summary.RETAINED.push(key); continue; }
  // Soft Space references die with the Space when the purge deletes it; the
  // purge deletes the user's PERSONAL and sole-member SHARED Spaces, and every
  // other Space the user touched belongs to someone else (the reference then
  // names a living Space, not the user).
  if (/[sS]paceId$/.test(c.column)) { summary.SPACE_CASCADE.push(key); continue; }
  unclassified.push(key);
}

check("FinancialAccount.ownerUserId is handled EXPLICITLY (SetNull at the FK is not a cascade)",
  summary.EXPLICIT.includes("FinancialAccount.ownerUserId"));
check("AiInvocation.userId is scrubbed explicitly (DB-002)", summary.EXPLICIT.includes("AiInvocation.userId"));
check("MerchantMergeDecision.decidedByUserId is scrubbed explicitly (DB-002)", summary.EXPLICIT.includes("MerchantMergeDecision.decidedByUserId"));
check("PlatformSetting.updatedById is scrubbed explicitly (DB-002)", summary.EXPLICIT.includes("PlatformSetting.updatedById"));
check("MerchantRule.ownerUserId (soft) is deleted explicitly", summary.EXPLICIT.includes("MerchantRule.ownerUserId"));
check("every RETAINED entry still names a real column (no stale documentation)",
  Object.keys(RETAINED).every((k) => columns.some((c) => `${c.model}.${c.column}` === k)),
  Object.keys(RETAINED).filter((k) => !columns.some((c) => `${c.model}.${c.column}` === k)).join());
check("every user-keyed column is classified", unclassified.length === 0, unclassified.join(", "));

// COMMS CENTER B2 HARDENING A9 — DERIVED identifier columns. Not user-keyed by NAME (the
// parser above cannot see them), but filled from a template that must name the recipient's
// id, so each must be scrubbed EXPLICITLY by the purge (delegate + column named there).
const DERIVED_USER_COLUMNS: ReadonlyArray<{ model: string; column: string; why: string }> = [
  { model: "AutomationRunItem", column: "dedupeKey", why: "filled from a dedupe template that must include {recipientId}" },
];
for (const d of DERIVED_USER_COLUMNS) {
  const body = models.find(([, m]) => m === d.model)?.[2] ?? "";
  check(`${d.model}.${d.column} exists in the schema (derived-identifier census target is real)`, new RegExp(`^\\s*${d.column}\\s+String`, "m").test(body));
  check(`${d.model}.${d.column} (${d.why}) is scrubbed explicitly by the purge`, explicit({ model: d.model, column: d.column, kind: "SOFT", onDelete: null }));
}

// PRIV-001 — the purge must name the sole-member SHARED Space predicate and
// delete Space-owned accounts of dying Spaces (DB-011).
check("purge deletes SHARED Spaces whose only active member is the user (PRIV-001)", /soleMemberSharedSpaceWhere\(/.test(purge) && /type:\s*\{\s*not:\s*SpaceType\.PERSONAL\s*\}/.test(purge));
check("purge deletes accounts owned by every dying Space, PERSONAL or SHARED (DB-011)", /ownerSpaceId:\s*\{\s*in:\s*dyingSpaceIds\s*\}/.test(purge));
check("the waitlist e-mail rows are purged on deletion (PRIV-012)", /betaAccessRequest\.deleteMany\(/.test(purge) && /betaAccessRequestEvent\.deleteMany\(/.test(purge));

console.log(`\n  census: ${columns.length} user-keyed columns — cascade ${summary.CASCADE.length}, setnull ${summary.SETNULL.length}, explicit ${summary.EXPLICIT.length}, retained ${summary.RETAINED.length}, space-cascade ${summary.SPACE_CASCADE.length}`);
if (process.env.CENSUS_VERBOSE) for (const [k, v] of Object.entries(summary)) console.log(`  ${k}: ${v.join(", ")}`);

if (failures > 0) { console.error(`\n❌ purge census: ${failures} check(s) failed`); process.exit(1); }
console.log("\n✅ purge census: all checks passed");
