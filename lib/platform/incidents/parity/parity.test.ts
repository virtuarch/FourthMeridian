/**
 * lib/platform/incidents/parity/parity.test.ts  (PB-1 §13 — the cutover gate, TEST-ONLY)
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/platform/incidents/parity/parity.test.ts
 *
 * Today (no Phase-2 module yet) this proves the harness is SENSITIVE: every
 * divergence in PB-1 §13.2 is reproduced from today's real reader logic on the
 * shared world, and every legacy-vs-projection difference is explained by a row
 * that exists to exercise it. When the module lands, set PHASE2_MODULE and the
 * gate compares the module with each reader: an unlisted mismatch fails.
 */

import { classifySyncIssue } from "@/lib/platform/sync-issue-semantics";
import { buildWorld, type World } from "./world";
import { LEGACY_READERS, type ReaderId, type Verdict } from "./legacy-readers";

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
 * The cutover gate. When the Phase-2 module exists, assign it here: (world) => Verdict[]
 * with reader "projection"-shaped output (open/state/severity/subjectUserId/groupKey).
 * ALLOWED lists the owner-approved corrections (PB-1 §13.2), keyed reader → D-id.
 */
const PHASE2_MODULE: ((w: World) => Verdict[]) | null = null;
export const ALLOWED_DIVERGENCES: Readonly<Record<ReaderId, readonly string[]>> = {
  "cs-panel": ["D1", "D4"],
  convergence: ["D2", "D3", "D6", "D7"],
  projection: ["D2"],
  alerts: [],
  "ops-attention": [],
  "cs-attention": ["D4"],
};

console.log("cutover gate");
if (!PHASE2_MODULE) {
  console.log("  · Phase-2 module not wired yet — gate pending (PB-1 §13.3 step 3)");
} else {
  const mod = openIds(PHASE2_MODULE(w));
  for (const id of Object.keys(LEGACY_READERS) as ReaderId[]) {
    const theirs = openIds(run(id));
    const diff = [...new Set([...theirs, ...mod])].filter((x) => theirs.has(x) !== mod.has(x));
    const unlisted = diff.filter((x) => !row(x).exercises.some((e) => ALLOWED_DIVERGENCES[id].includes(e)));
    check(`module vs ${id}: no unlisted divergence`, unlisted.length === 0, unlisted);
  }
}

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nall checks passed");
