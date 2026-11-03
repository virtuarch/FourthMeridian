/**
 * scripts/test-incident-phase1-lifecycle.ts  (PB-1 Phase 1 — disposable-PG harness)
 *
 * The full data lifecycle against a REAL PostgreSQL with every migration
 * applied: observe → close as SUBJECT_REMOVED → archive-on-prune → account-
 * deletion purge ⇒ nothing about the customer remains, including a LEGACY row
 * (subjectUserId NULL), while provider-wide history with no subject survives.
 *
 * NOT a unit test (named test-*.ts so run-tests never picks it up). It REFUSES
 * any database whose name does not look like a throwaway clone.
 *
 *   DATABASE_URL=postgresql://…/fm_pb1s2_clone \
 *     npx tsx --require ./scripts/lib/server-only-preload.cjs scripts/test-incident-phase1-lifecycle.ts
 */

import { systemDb } from "@/lib/db";
import { recordSyncIssue, resolveIncidentsForRemovedSubjects } from "@/lib/plaid/syncIssues";
import { archiveAndPruneSyncIssues } from "@/lib/platform/incidents/retention";
import { purgeIncidentSet, resolveIncidentPurgeSet } from "@/lib/platform/incidents/purge";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const url = process.env.DATABASE_URL ?? "";
const dbName = url.split("/").pop()?.split("?")[0] ?? "";
if (!/clone|throwaway|fm_ci|test/i.test(dbName)) {
  console.error(`refusing to run against "${dbName}" — throwaway clones only`);
  process.exit(2);
}

const db = systemDb;
const U = "u_phase1", OTHER = "u_phase1_other", C1U = "u_phase1_c1";

async function main() {
  // Reset (throwaway only) through the delegates — no raw SQL touches an account FK.
  await db.syncIssueEvent.deleteMany({});
  await db.syncIssueRelation.deleteMany({});
  await db.syncIssueArchive.deleteMany({});
  await db.syncIssue.deleteMany({});
  await db.financialAccount.deleteMany({ where: { id: { in: ["fa_p1", "fa_p1_other", "fa_c1"] } } });
  await db.plaidItem.deleteMany({ where: { id: "pi_p1" } });
  await db.user.deleteMany({ where: { id: { in: [U, OTHER, C1U] } } });
  await db.user.createMany({ data: [{ id: U, email: "p1@example.test" }, { id: OTHER, email: "p1o@example.test" }, { id: C1U, email: "p1c1@example.test" }] });
  await db.plaidItem.create({ data: { id: "pi_p1", userId: U, externalItemId: "ext", institutionId: "ins", institutionName: "A brokerage", encryptedToken: "" } });
  await db.financialAccount.createMany({ data: [
    { id: "fa_p1", name: "Wallet", institution: "Self-custody", type: "crypto", ownerType: "USER", ownerUserId: U },
    { id: "fa_p1_other", name: "Other", institution: "Self-custody", type: "crypto", ownerType: "USER", ownerUserId: OTHER },
  ] });

  console.log("1. observation stamps the authoritative owner and structured subjects");
  await recordSyncIssue({ kind: "WALLET_SYNC_FAILED", provider: "WALLET", financialAccountId: "fa_p1", detail: { stage: "price" } });
  await recordSyncIssue({ kind: "INVESTMENT_DATA_PERSISTENCE_FAILED", plaidItemId: "pi_p1", detail: { stage: "reconstruction-repair", financialAccountId: "fa_p1" } });
  await recordSyncIssue({ kind: "WALLET_SYNC_FAILED", provider: "WALLET", financialAccountId: "fa_p1_other", detail: { stage: "price" } });
  const wallet = await db.syncIssue.findFirst({ where: { financialAccountId: "fa_p1" }, include: { occurrences: true } });
  const item = await db.syncIssue.findFirst({ where: { plaidItemId: "pi_p1" }, include: { occurrences: true } });
  check("subjectUserId from the account owner", wallet?.subjectUserId === U, String(wallet?.subjectUserId));
  check("subjectUserId from the Item's user", item?.subjectUserId === U, String(item?.subjectUserId));
  check("the item-scoped occurrence lifts the account subject into its column", item?.occurrences[0]?.subjectAccountId === "fa_p1");
  check("openedBy = OBSERVATION, lifecycleState NULL (derived)", wallet?.openedBy === "OBSERVATION" && wallet?.lifecycleState === null);
  const observed = await db.syncIssueEvent.findMany({ where: { incidentId: wallet!.id } });
  check("one OBSERVED event, stamped by the database", observed.length === 1 && observed[0].type === "OBSERVED" && observed[0].at instanceof Date);
  // A LEGACY row (pre-Phase-1 shape): no owner, no key, on the user's Item.
  await db.syncIssue.create({ data: { id: "si_legacy", kind: "UPSERT_ERROR", plaidItemId: "pi_p1", resolved: false } });
  // Provider-wide history with no customer subject.
  await db.syncIssue.create({ data: { id: "si_provider_wide", kind: "UPSERT_ERROR", provider: "PLAID", resolved: false } });

  console.log("\n2. removal closes as SUBJECT_REMOVED (CAS + event in one transaction)");
  await db.financialAccount.update({ where: { id: "fa_p1" }, data: { deletedAt: new Date() } });
  const closed = await resolveIncidentsForRemovedSubjects({ financialAccountIds: ["fa_p1"] });
  const after = await db.syncIssue.findUnique({ where: { id: wallet!.id } });
  check("the wallet incident closed", closed >= 1 && after?.resolved === true && after.resolutionKind === "SUBJECT_REMOVED" && after.lifecycleState === "RESOLVED");
  check("reason is a registry code; no execution named", after?.resolutionReasonCode === "SUBJECT_DELETED" && after.resolvingExecutionId === null);
  const sc = await db.syncIssueEvent.findMany({ where: { incidentId: wallet!.id, type: "STATE_CHANGED" } });
  check("a STATE_CHANGED event followed the CAS", sc.length === 1 && sc[0].toState === "RESOLVED");
  const itemAfter = await db.syncIssue.findUnique({ where: { id: item!.id } });
  check("the item-scoped episode closes only when EVERY account subject is removed (here: its one account)", itemAfter?.resolved === true);

  console.log("\n3. archive-on-prune is atomic and idempotent");
  const where = { resolved: true };
  const pruned = await archiveAndPruneSyncIssues(db as never, [wallet!.id], where);
  const arch = await db.syncIssueArchive.findUnique({ where: { incidentId: wallet!.id } });
  check("archived then deleted", pruned === 1 && !!arch && (await db.syncIssue.count({ where: { id: wallet!.id } })) === 0);
  check("the archive keeps the owner, codes and a code-only timeline",
    arch?.subjectUserId === U && arch.resolutionReasonCode === "SUBJECT_DELETED"
    && Array.isArray((arch.eventTimeline as { events?: unknown[] } | null)?.events) && (arch.eventTimeline as { events: unknown[] }).events.length === 2);
  check("the live events went with the row", (await db.syncIssueEvent.count({ where: { incidentId: wallet!.id } })) === 0);
  const again = await archiveAndPruneSyncIssues(db as never, [wallet!.id], where);
  check("a re-run neither duplicates nor fails", again === 0 && (await db.syncIssueArchive.count({ where: { incidentId: wallet!.id } })) === 1);
  check("no `detail` column exists on the archive", !Object.keys(arch ?? {}).includes("detail"));
  await db.syncIssueRelation.create({ data: { fromIncidentId: "si_legacy" < "si_provider_wide" ? "si_legacy" : "si_provider_wide", toIncidentId: "si_legacy" < "si_provider_wide" ? "si_provider_wide" : "si_legacy", kind: "RELATED", createdBy: "SYSTEM" } });

  console.log("\n4. account-deletion purge — nothing about the customer remains");
  const set = await resolveIncidentPurgeSet(db as never, { userId: U, plaidItemIds: ["pi_p1"], financialAccountIds: ["fa_p1"] });
  check("the set includes the LEGACY row (no subjectUserId)", set.incidentIds.includes("si_legacy"));
  await db.$transaction(async (tx) => { await purgeIncidentSet(tx as never, set); });
  const leftLive = await db.syncIssue.findMany({ where: { OR: [{ subjectUserId: U }, { plaidItemId: "pi_p1" }, { financialAccountId: "fa_p1" }] } });
  const leftArch = await db.syncIssueArchive.findMany({ where: { OR: [{ subjectUserId: U }, { plaidItemId: "pi_p1" }, { financialAccountId: "fa_p1" }] } });
  const leftEvents = await db.syncIssueEvent.findMany({ where: { incidentId: { in: [...set.incidentIds, ...set.archivedIncidentIds] } } });
  const leftRel = await db.syncIssueRelation.findMany({ where: { OR: [{ fromIncidentId: { in: set.incidentIds } }, { toIncidentId: { in: set.incidentIds } }] } });
  check("no live incident, archive, event or relation about the customer remains",
    leftLive.length === 0 && leftArch.length === 0 && leftEvents.length === 0 && leftRel.length === 0,
    `${leftLive.length}/${leftArch.length}/${leftEvents.length}/${leftRel.length}`);
  check("provider-wide history survives", (await db.syncIssue.count({ where: { id: "si_provider_wide" } })) === 1);
  check("another customer's incident survives", (await db.syncIssue.count({ where: { subjectUserId: OTHER } })) === 1);

  console.log("\n5. C1 — a LEGACY row's owner is resolved at archive time, so a later purge still finds it");
  await db.financialAccount.create({ data: { id: "fa_c1", name: "Old", institution: "Self-custody", type: "crypto", ownerType: "USER", ownerUserId: C1U } });
  const old = new Date(Date.now() - 200 * 86_400_000);
  await db.syncIssue.create({ data: { id: "si_c1_legacy", kind: "UPSERT_ERROR", provider: "WALLET", financialAccountId: "fa_c1",
    resolved: true, resolvedAt: old, resolutionKind: "AUTOMATIC_RECOVERY" } });
  await archiveAndPruneSyncIssues(db as never, ["si_c1_legacy"], { resolved: true });
  const c1Arch = await db.syncIssueArchive.findUnique({ where: { incidentId: "si_c1_legacy" } });
  check("the legacy source had no owner; the archive row carries the account owner", c1Arch?.subjectUserId === C1U, String(c1Arch?.subjectUserId));
  // The account is hard-deleted (its last link to the customer), THEN the customer is purged.
  await db.financialAccount.delete({ where: { id: "fa_c1" } });
  const c1Set = await resolveIncidentPurgeSet(db as never, { userId: C1U, plaidItemIds: [], financialAccountIds: [] });
  check("the purge set still finds the archive row (by subjectUserId alone)", c1Set.archiveIds.includes(c1Arch!.id));
  await db.$transaction(async (tx) => { await purgeIncidentSet(tx as never, c1Set); });
  check("after the purge the archive row is gone", (await db.syncIssueArchive.count({ where: { incidentId: "si_c1_legacy" } })) === 0);

  await db.$disconnect();
  if (failures > 0) { console.error(`\n❌ phase-1 lifecycle harness: ${failures} failure(s)`); process.exit(1); }
  console.log("\n✅ phase-1 lifecycle harness: all checks passed");
}

main().catch(async (e) => { console.error(e); await db.$disconnect(); process.exit(1); });
