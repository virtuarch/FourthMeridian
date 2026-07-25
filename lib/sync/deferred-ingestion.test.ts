/**
 * lib/sync/deferred-ingestion.test.ts  (OPS-2D-4A follow-up)
 *
 * "Connected, sync pending" must never be guessed.
 *
 * The gap this closes was a lie of omission: an ingestion-paused connection set
 * `syncIncompleteAt`, and every surface renders that as "Importing" — so the
 * card told the customer work was happening when nothing was running and
 * nothing would until an operator acted.
 *
 * The fix is not new copy, it is a new EVIDENCE requirement, and that is what
 * this file guards. `syncIncompleteAt` is a precondition; the decision comes
 * from the refresh ledger. §1 pins that distinction against the four situations
 * that all set the same marker, because the tempting shortcut — "incomplete
 * therefore deferred" — would silently relabel three of them.
 *
 * Run:  npx tsx lib/sync/deferred-ingestion.test.ts
 */

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { deriveIngestionDeferral } from "./deferred-ingestion";
import { deriveConnectionState, buildSyncStatus } from "./status";
import { ADMISSION_REASONS } from "@/lib/platform/admission/types";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const ROOT = process.cwd();
const code = (rel: string) =>
  readFileSync(path.join(ROOT, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

function walk(dir: string, out: string[] = []): string[] {
  let entries;
  try { entries = readdirSync(path.join(ROOT, dir), { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name === "node_modules" || e.name === ".next" || e.name === "prototype") continue;
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) walk(rel, out);
    else if (/\.tsx?$/.test(e.name)) out.push(rel);
  }
  return out;
}

const denied = { overallStatus: "SKIPPED", admissionReason: "INGESTION_PAUSED" };
const item = (over: Partial<Parameters<typeof buildSyncStatus>[0][number]> = {}) => ({
  id: "i1", institutionName: "Test Bank", status: "ACTIVE",
  syncIncompleteAt: new Date(), historyBuildStartedAt: null, lastSyncedAt: null,
  errorCode: null, investmentsConsent: null, syncImportedCount: 0,
  historyBuildTotalDays: null, historyBuildDoneDays: null, ...over,
}) as Parameters<typeof buildSyncStatus>[0][number];

function main() {
  // ── 1. syncIncompleteAt alone is NEVER enough ───────────────────────────────
  console.log("1. the four situations that share syncIncompleteAt stay distinct");
  {
    // (a) actively importing — a sync holds the lock.
    check("active import (lock held) is NOT deferred",
      deriveIngestionDeferral({ syncLockedAt: new Date(), latestExecution: denied }) === null);
    // (b) a run is in flight per the ledger.
    check("RUNNING execution is NOT deferred",
      deriveIngestionDeferral({ syncLockedAt: null,
        latestExecution: { overallStatus: "RUNNING", admissionReason: null } }) === null);
    // (c) interrupted / stale candidate — skipped, but for contention, not policy.
    check("SKIPPED without an admission reason is NOT deferred (lock contention)",
      deriveIngestionDeferral({ syncLockedAt: null,
        latestExecution: { overallStatus: "SKIPPED", admissionReason: null } }) === null);
    // (d) never ran at all.
    check("no execution history is NOT deferred",
      deriveIngestionDeferral({ syncLockedAt: null, latestExecution: null }) === null);
    // …and the one that IS.
    check("SKIPPED + admissionReason IS deferred",
      deriveIngestionDeferral({ syncLockedAt: null, latestExecution: denied })?.reason === "INGESTION_PAUSED");

    // A failed or succeeded latest execution is not deferral either.
    for (const st of ["SUCCEEDED", "FAILED", "PARTIAL"]) {
      check(`latest ${st} is NOT deferred`,
        deriveIngestionDeferral({ syncLockedAt: null,
          latestExecution: { overallStatus: st, admissionReason: "INGESTION_PAUSED" } }) === null);
    }
  }

  // ── 2. The state machine renders the distinction ────────────────────────────
  console.log("2. deferred renders as its own state, never as importing");
  {
    const pending = item();
    check("incomplete + no deferral → importing (unchanged behaviour)",
      deriveConnectionState(pending, null) === "importing");
    check("incomplete + deferral → sync_deferred",
      deriveConnectionState(pending, { reason: "INGESTION_PAUSED" }) === "sync_deferred");
    // Everything else is untouched by the new argument.
    check("complete → ready regardless of a stale deferral",
      deriveConnectionState(item({ syncIncompleteAt: null }), { reason: "INGESTION_PAUSED" }) === "ready");
    check("NEEDS_REAUTH stays needs_reauth",
      deriveConnectionState(item({ status: "NEEDS_REAUTH" }), { reason: "INGESTION_PAUSED" }) === "needs_reauth");
    check("ERROR stays error",
      deriveConnectionState(item({ status: "ERROR" }), { reason: "INGESTION_PAUSED" }) === "error");
    check("REVOKED stays excluded",
      deriveConnectionState(item({ status: "REVOKED" }), { reason: "INGESTION_PAUSED" }) === null);
  }

  // ── 3. The projection carries the code, and only where it applies ───────────
  console.log("3. the reason code rides on the contract, never the copy");
  {
    const s = buildSyncStatus([item()], new Map([["i1", { reason: "INGESTION_PAUSED" }]]));
    check("state is sync_deferred", s.connections[0].state === "sync_deferred");
    check("deferredReason carries the typed code", s.connections[0].deferredReason === "INGESTION_PAUSED");
    check("importedCount is null — no progress to report", s.connections[0].importedCount === null);
    // A deferred connection is NOT "building": a poller keyed on building would
    // otherwise spin forever against work that is not running.
    check("building is false when the only connection is deferred", s.building === false);

    const active = buildSyncStatus([item()], new Map());
    check("without a deferral the shape is unchanged",
      active.connections[0].state === "importing" && active.connections[0].deferredReason === null);
  }

  // ── 4. Copy ownership ───────────────────────────────────────────────────────
  console.log("4. customer copy hides the code; operator copy uses the registry");
  {
    const card = code("components/connections/ConnectionCard.tsx");
    check("the customer card renders a plain sentence for the deferred state",
      /Sync pending/.test(card) && /no action is needed from you/i.test(card));
    check("the customer card exposes NO reason code or internal vocabulary",
      !/INGESTION_PAUSED|MAINTENANCE_MODE|CONTROL_PLANE_|RefreshExecution|admissionReason|PlatformSetting/.test(card));
    check("the customer card does not claim the connection is importing",
      !/case "sync_deferred":[\s\S]{0,200}ImportingContent/.test(card));

    // No surface may hardcode a reason label — that copy has one home.
    const dupes = [...walk("components"), ...walk("app").filter((f) => /\.tsx$/.test(f))]
      .filter((f) => Object.values(ADMISSION_REASONS).some((label) => code(f).includes(label)));
    check("no UI file duplicates an admission reason label", dupes.length === 0, dupes.join(", "));
  }

  // ── 5. One authority — no component re-derives the state ────────────────────
  console.log("5. every surface consumes the projection; none reconstructs it");
  {
    const consumers = [...walk("components"), ...walk("app"), ...walk("lib")]
      .filter((f) => !/\.test\.tsx?$/.test(f))
      .filter((f) => f !== "lib/sync/deferred-ingestion.ts" && f !== "lib/platform/refresh/projections.ts");
    // A component must never look at the ledger or the marker to decide this.
    const offenders = consumers.filter((f) => {
      const s = code(f);
      return /admissionReason/.test(s) && /syncIncompleteAt/.test(s) && f.startsWith("components/");
    });
    check("no component pairs admissionReason with syncIncompleteAt", offenders.length === 0, offenders.join(", "));

    // The ledger read lives in the projection layer — asserted here too so the
    // Phase B authority cannot drift back out of it.
    check("the deferral projection lives at the aggregate seam",
      /export async function getIngestionDeferrals/.test(code("lib/platform/refresh/projections.ts")));
    check("the pure rule holds no database access",
      !/db\.|prisma|findMany/.test(code("lib/sync/deferred-ingestion.ts")));
    check("the customer data path resolves deferrals before deriving state",
      /getIngestionDeferrals\(/.test(code("lib/connections/space-data.ts")));

    // The operator surface has its own state, distinct from IMPORTING.
    const diag = code("lib/platform/connection-diagnostics.ts");
    check("operator diagnostics expose SYNC_DEFERRED as its own status",
      /"IMPORTING" \| "SYNC_DEFERRED" \| "READY" \| "ACTION_REQUIRED"/.test(diag));
    check("operator diagnostics derive it from the shared state, not a local rule",
      /state === "sync_deferred" \? "SYNC_DEFERRED"/.test(diag));
  }

  // ── 6. The poller does not spin on a deferred card ──────────────────────────
  console.log("6. nothing polls work that is not running");
  {
    const list = code("components/connections/ConnectionsList.tsx");
    check("the in-progress predicate excludes sync_deferred", !/sync_deferred/.test(list));
  }

  if (failures > 0) {
    console.error(`\ndeferred-ingestion.test: ${failures} failure(s).`);
    process.exit(1);
  }
  console.log("\ndeferred-ingestion.test: all passed.");
}

main();
