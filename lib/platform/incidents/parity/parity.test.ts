/**
 * lib/platform/incidents/parity/parity.test.ts  (PB-1 §13 — the cutover gate, TEST-ONLY)
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/platform/incidents/parity/parity.test.ts
 *
 * Two halves. (1) SENSITIVITY: every divergence in PB-1 §13.2 is reproduced from
 * today's real reader logic on the shared world, and every legacy-vs-projection
 * difference is explained by a row built to exercise it. (2) THE CUTOVER GATE:
 * the Phase-2 module (intelligence/core.ts, fed through ./module-adapter.ts) is
 * compared with each reader in that reader's own sense of "open"; an unlisted
 * divergence fails, and each listed correction is asserted to actually hold.
 */

import { classifySyncIssue } from "@/lib/platform/sync-issue-semantics";
import type { CsIncidentVerdict, IncidentVerdict } from "@/lib/platform/incidents/intelligence/types";
import { buildWorld } from "./world";
import { LEGACY_READERS, projectionReader, type ReaderId, type Verdict } from "./legacy-readers";
import { moduleVerdicts } from "./module-adapter";

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`); }
}

const w = buildWorld();
const run = (id: ReaderId): Verdict[] => LEGACY_READERS[id](w);
const openIds = (vs: Verdict[]) => new Set(vs.filter((v) => v.open).map((v) => v.rowId));
const row = (id: string) => w.rows.find((r) => r.id === id)!;

console.log("§13.2 — every divergence is reproduced from today's readers");
const projection = openIds(run("projection"));
const csPanel = openIds(run("cs-panel"));
const convergence = run("convergence");
const convOpen = openIds(convergence);
const csAttention = run("cs-attention");

check("D1: the CS panel shows tombstone / superseded / orphan rows as open; the projection does not",
  ["r_tombstone_open", "r_superseded_open", "r_orphan_item"].every((id) => csPanel.has(id) && !projection.has(id)));
check("D2: an item-live / account-deleted row is orphaned for the projection but live for convergence",
  !projection.has("r_item_live_acct_hard") && convOpen.has("r_item_live_acct_hard"));
check("D2: neither reader honours a SOFT-deleted account (both still treat it as existing)",
  projection.has("r_acct_soft_deleted") && convOpen.has("r_acct_soft_deleted"));
const withTxn = classifySyncIssue({ kind: "UPSERT_ERROR", provider: "PLAID", detail: null, plaidTransactionId: "txn_1" });
const withoutTxn = classifySyncIssue({ kind: "UPSERT_ERROR", provider: "PLAID", detail: null });
check("D3: dropping plaidTransactionId can change the classification convergence sees",
  withTxn.domain !== withoutTxn.domain || withTxn.severity !== withoutTxn.severity || withTxn.customerActionable !== withoutTxn.customerActionable,
  { withTxn, withoutTxn });
check("D4: a manual-account incident is attributed by CS attention but missing from the CS panel",
  csAttention.some((v) => v.rowId === "r_manual_account" && v.subjectUserId === "u_bob") && !csPanel.has("r_manual_account"));
check("D6: an incident created before the 14-day window is active for the projection but invisible to convergence",
  projection.has("r_old_but_active") && !convergence.some((v) => v.rowId === "r_old_but_active"));
check("D8: no reader groups the recurrence pair by incidentKey",
  ![...run("alerts"), ...convergence].some((v) => v.groupKey?.includes("k_recur")) && row("r_recur_2").incidentKey === "k_recur");

check("D2b baseline: every legacy reader treats a REVOKED item's incident as live (the module will close it)",
  projection.has("r_revoked_item") && csPanel.has("r_revoked_item") && convOpen.has("r_revoked_item"));
check("D10 baseline: a long-silent unresolved incident is open for every legacy reader (the module marks it stale-unverified)",
  projection.has("r_stale_open") && csPanel.has("r_stale_open"));

console.log("every legacy-vs-projection difference is explained by the world");
for (const id of ["cs-panel", "convergence"] as const) {
  const theirs = openIds(run(id));
  const diff = [...new Set([...theirs, ...projection])].filter((x) => theirs.has(x) !== projection.has(x));
  const unexplained = diff.filter((x) => row(x).exercises.every((e) => e === "baseline"));
  check(`${id}: ${diff.length} difference(s), all on rows built to exercise a §13.2 divergence`, unexplained.length === 0, unexplained);
}
check("alerts and ops-attention select only from the projection's active set (R4–R6 agree)",
  [...openIds(run("alerts")), ...openIds(run("ops-attention"))].every((x) => projection.has(x)));
check("Platform Ops attention carries no customer identity", run("ops-attention").every((v) => v.subjectUserId === undefined));

/**
 * The cutover gate (PB-1 §13.3 step 3). The Phase-2 module's verdicts over the
 * same world, read the way each legacy reader means "open":
 *   projection / ops-attention / cs-attention / cs-panel  ⇔ brokenNow
 *   alerts       ⇔ alertable && severity === "critical"   (R5 alerts on critical only)
 *   convergence  ⇔ state === "active"
 * ALLOWED lists the owner-approved corrections (PB-1 §13.2), keyed reader → D-id.
 * An unlisted divergence fails; so does a listed one the world no longer exercises
 * for a reader whose cutover depends on it (checked below).
 */
const PHASE2_MODULE = moduleVerdicts;
const MODULE_OPEN: Readonly<Record<ReaderId, (v: IncidentVerdict) => boolean>> = {
  projection: (v) => v.brokenNow,
  "ops-attention": (v) => v.brokenNow,
  "cs-attention": (v) => v.brokenNow,
  "cs-panel": (v) => v.brokenNow,
  alerts: (v) => v.alertable && v.severity === "critical",
  convergence: (v) => v.state === "active",
};
export const ALLOWED_DIVERGENCES: Readonly<Record<ReaderId, readonly string[]>> = {
  "cs-panel": ["D1", "D2", "D2b", "D4", "D10"],
  convergence: ["D2", "D2b", "D3", "D6", "D7", "D10"],
  projection: ["D2", "D2b", "D10"],
  // D2: alerts select from the projection's active set, which does not honour a soft-deleted account.
  alerts: ["D2", "D2b", "D10"],
  "ops-attention": ["D2", "D2b", "D10"],
  "cs-attention": ["D2", "D2b", "D4", "D10"],
};

console.log("cutover gate");
const verdicts = PHASE2_MODULE(w);
const byId = new Map(verdicts.map((v) => [v.id, v] as const));
check("the module returns one verdict per world row", w.rows.every((r) => byId.has(r.id)) && verdicts.length === w.rows.length);
for (const id of Object.keys(LEGACY_READERS) as ReaderId[]) {
  const mod = new Set(verdicts.filter(MODULE_OPEN[id]).map((v) => v.id));
  const theirs = openIds(run(id));
  const diff = [...new Set([...theirs, ...mod])].filter((x) => theirs.has(x) !== mod.has(x));
  const unlisted = diff.filter((x) => !row(x).exercises.some((e) => ALLOWED_DIVERGENCES[id].includes(e)));
  check(`module vs ${id}: ${diff.length} divergence(s), all owner-approved`, unlisted.length === 0,
    unlisted.map((x) => ({ row: x, legacyOpen: theirs.has(x), moduleOpen: mod.has(x) })));
}

console.log("the module's corrections hold (not merely allowed)");
const v = (id: string) => byId.get(id)!;
check("D1: tombstone / superseded rows are never broken now",
  !v("r_tombstone_open").brokenNow && !v("r_superseded_open").brokenNow && v("r_superseded_open").rowClass !== "incident");
check("D2: a soft-deleted account and a hard-deleted one both read connection removed",
  ["r_acct_soft_deleted", "r_item_live_acct_hard", "r_orphan_item"].every((id) => !v(id).brokenNow && v(id).closure === "connection-removed"));
check("D2b: a REVOKED item's incident reads connection removed", !v("r_revoked_item").brokenNow && v("r_revoked_item").subjectState === "REVOKED");
check("D3: the transaction-scoped row is classified with plaidTransactionId (same as the projection)",
  v("r_txn_scoped").severity === projectionReader(w).find((x) => x.rowId === "r_txn_scoped")?.severity);
check("D6: an incident created before any window is still broken now", v("r_old_but_active").brokenNow);
check("D8: the recurrence pair shares one episode key", v("r_recur_1").episodeKey === v("r_recur_2").episodeKey && v("r_recur_2").episodeKey === "k_recur");
check("D10: known-empty evidence past the window ⇒ stale-unverified, NOT broken now, never alertable",
  v("r_stale_open").state === "stale-unverified" && v("r_stale_open").freshness === "stale" && !v("r_stale_open").brokenNow && !v("r_stale_open").alertable);
check("D10: UNKNOWN evidence past the window ⇒ unverified, STILL broken now (unknown never hides a row), not alertable",
  v("r_stale_unknown").freshness === "unverified" && v("r_stale_unknown").brokenNow && !v("r_stale_unknown").alertable);
check("a live in-window condition is broken now and current", v("r_condition_open").brokenNow && v("r_condition_open").freshness === "current");
check("a resolved row is never broken now", !v("r_condition_resolved").brokenNow && !v("r_recur_1").brokenNow);

console.log("D4 — attribution, CUSTOMER_SUCCESS tier only");
const cs = new Map(moduleVerdicts(w, "CUSTOMER_SUCCESS").map((x) => [x.id, x as CsIncidentVerdict] as const));
check("the manual account's incident is attributed to its creator (owner null ⇒ createdBy)", cs.get("r_manual_account")?.subjectUserId === "u_bob");
check("an item-scoped incident is attributed to the item's owner", cs.get("r_condition_open")?.subjectUserId === "u_alice");
for (const a of ["PLATFORM_OPS", "SYSTEM"] as const) {
  check(`${a} verdicts carry no subjectUserId key and name no customer`,
    moduleVerdicts(w, a).every((x) => !("subjectUserId" in x)) && !/u_alice|u_bob/.test(JSON.stringify(moduleVerdicts(w, a))));
}

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nall checks passed");
