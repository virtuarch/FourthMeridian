/**
 * scripts/test-snapshot-amendment-fk.ts
 *
 * DB harness (NOT a unit test — needs a live Postgres, so it is named
 * `test-*.ts` and excluded from `npm run test:unit`, per scripts/run-tests.ts).
 *
 *     npx tsx scripts/test-snapshot-amendment-fk.ts
 *
 * Verifies the Fix-1 invariant: a SnapshotAmendment and its stored per-day
 * breakdown (SnapshotAmendmentDay) SURVIVE a hard-delete of the account they
 * reference. financialAccountId is a soft ref (no FK) precisely so the stored
 * delta stays true after ACCOUNT_HARD_DELETED — an onDelete: Cascade FK would
 * have destroyed both rows. Uses a disposable space + account, cleaned up after.
 */

import { config } from "dotenv";
config({ path: ".env.local" });
import { db } from "@/lib/db";

let fail = 0;
const ok = (n: string, c: boolean, d?: string) => { console.log(`${c ? "  ✓" : "  ✗"} ${n}${!c && d ? ` — ${d}` : ""}`); if (!c) fail++; };

async function main() {
  const user = await db.user.findFirst({ select: { id: true } });
  if (!user) throw new Error("no user in DB to own the disposable fixtures");

  const space = await db.space.create({ data: { name: "__AMEND_FK__", type: "PERSONAL", reportingCurrency: "USD" }, select: { id: true } });
  const acct = await db.financialAccount.create({
    data: { name: "__amend_fk_acct__", type: "checking", institution: "Test", ownerType: "USER", ownerUserId: user.id, createdByUserId: user.id, balance: 100, currency: "USD" },
    select: { id: true },
  });

  try {
    // An amendment with an APPLIED per-day breakdown referencing the account.
    const amendment = await db.snapshotAmendment.create({
      data: {
        spaceId: space.id,
        financialAccountId: acct.id,
        kind: "ACCOUNT_HARD_DELETED",
        fromDate: new Date("2026-06-01T00:00:00Z"),
        toDate: new Date("2026-06-02T00:00:00Z"),
        requestedByUserId: user.id,
        status: "APPLIED",
        appliedAt: new Date(),
        consentedAt: new Date(),
        days: {
          create: [
            { date: new Date("2026-06-01T00:00:00Z"), netWorthBefore: 1000, netWorthAfter: 1500, cashBefore: 1000, cashAfter: 1500 },
            { date: new Date("2026-06-02T00:00:00Z"), netWorthBefore: 1100, netWorthAfter: 1600, cashBefore: 1100, cashAfter: 1600 },
          ],
        },
      },
      select: { id: true },
    });

    const beforeDays = await db.snapshotAmendmentDay.findMany({ where: { amendmentId: amendment.id }, orderBy: { date: "asc" }, select: { date: true, netWorthBefore: true, netWorthAfter: true, cashBefore: true, cashAfter: true } });
    ok("setup: 2 breakdown rows created", beforeDays.length === 2);

    // ── Hard-delete the referenced account ──────────────────────────────────
    await db.financialAccount.delete({ where: { id: acct.id } });
    ok("account hard-deleted", (await db.financialAccount.findUnique({ where: { id: acct.id }, select: { id: true } })) === null);

    // ── The amendment + its breakdown must SURVIVE, unchanged ────────────────
    const survived = await db.snapshotAmendment.findUnique({ where: { id: amendment.id }, select: { id: true, financialAccountId: true, kind: true, status: true } });
    ok("SnapshotAmendment row survives the account hard-delete", survived !== null);
    ok("financialAccountId is preserved as a soft ref (still the deleted id)", survived?.financialAccountId === acct.id);
    ok("amendment kind/status unchanged", survived?.kind === "ACCOUNT_HARD_DELETED" && survived?.status === "APPLIED");

    const afterDays = await db.snapshotAmendmentDay.findMany({ where: { amendmentId: amendment.id }, orderBy: { date: "asc" }, select: { date: true, netWorthBefore: true, netWorthAfter: true, cashBefore: true, cashAfter: true } });
    ok("SnapshotAmendmentDay breakdown rows survive (still 2)", afterDays.length === 2);
    ok("breakdown values unchanged after the delete", JSON.stringify(afterDays) === JSON.stringify(beforeDays), `before=${JSON.stringify(beforeDays)} after=${JSON.stringify(afterDays)}`);
  } finally {
    // Space delete cascades the amendment + its breakdown; account already gone.
    for (const s of await db.space.findMany({ where: { name: "__AMEND_FK__" }, select: { id: true } })) await db.space.delete({ where: { id: s.id } });
    for (const a of await db.financialAccount.findMany({ where: { name: "__amend_fk_acct__" }, select: { id: true } })) await db.financialAccount.delete({ where: { id: a.id } });
  }

  if (fail) { console.error(`\n${fail} check(s) FAILED`); process.exit(1); }
  console.log("\nSnapshotAmendment FK-survival harness passed.");
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => db.$disconnect());
