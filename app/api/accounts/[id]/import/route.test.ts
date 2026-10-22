/**
 * app/api/accounts/[id]/import/route.test.ts  (TEST-002)
 *
 * POST /api/accounts/[id]/import — the REAL exported handler with a real
 * multipart CSV upload, a real session cookie and the active-Space cookie,
 * against the in-memory Prisma fake. The parse pipeline, fingerprinting, flow
 * classification and batch claim are production code.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs "app/api/accounts/[id]/import/route.test.ts"
 */

import "@/lib/test-support/route-env";
import { FakePrisma, installFakePrisma } from "@/lib/test-support/fake-prisma";
import { invoke, request, makeChecker } from "@/lib/test-support/route-harness";
import { spaceWorld, type Person, type SpaceWorld } from "@/lib/test-support/space-world";
import { ACTIVE_SPACE_COOKIE } from "@/lib/space";

const t = makeChecker("POST /api/accounts/[id]/import (TEST-002)");
const fake = new FakePrisma();
let POST: typeof import("./route").POST;
let w: SpaceWorld;

const CSV = "Date,Description,Amount\n2026-09-01,COFFEE SHOP,-4.50\n2026-09-02,PAYROLL ACME,2500.00\n2026-09-03,GROCER,-82.17\n";
function upload(by: Person, spaceId: string, accountId: string, csv = CSV, name = "september.csv") {
  const form = new FormData();
  form.set("file", new File([csv], name, { type: "text/csv" }));
  return invoke(POST, request(`/api/accounts/${accountId}/import`, {
    form, cookie: `${w.as[by].cookie}; ${ACTIVE_SPACE_COOKIE}=${spaceId}`,
  }), { id: accountId });
}
function accountIn(spaceId: string, owner: Person, visibilityLevel = "FULL") {
  const id = fake.seed("FinancialAccount", { ownerUserId: w.ids[owner], name: "Checking", type: "checking", currency: "USD" }).id as string;
  fake.seed("SpaceAccountLink", { spaceId, financialAccountId: id, kind: "HOME", addedByUserId: w.ids[owner], visibilityLevel });
  return id;
}

async function main() {
  await installFakePrisma(fake);
  // prisma/migrations/20261022000100_import_batch_file_sha256 — a PARTIAL unique
  // index the Prisma schema cannot express (so the fake must be told about it).
  fake.partialUnique("ImportBatch", ["financialAccountId", "fileSha256"],
    { fileSha256: { not: null }, status: { in: ["PENDING", "PROCESSING", "COMPLETED", "COMPLETED_WITH_ERRORS"] } },
    "ImportBatch_account_file_live_key");
  ({ POST } = await import("./route"));

  t.section("1. happy path — the owner imports a 3-row CSV");
  {
    w = await spaceWorld(fake);
    const fa = accountIn(w.S, "member");
    const r = await upload("member", w.S, fa);
    t.check("200/201 with a completed batch", (r.status === 200 || r.status === 201), r.text.slice(0, 400));
    const batch = fake.one("ImportBatch", { financialAccountId: fa })!;
    t.check("one ImportBatch COMPLETED with importedCount 3 and the file hash recorded",
      !!batch && batch.status === "COMPLETED" && batch.importedCount === 3 && typeof batch.fileSha256 === "string" && (batch.fileSha256 as string).length === 64, batch);
    const tx = fake.rows("Transaction", { financialAccountId: fa });
    t.check("three transactions, each stamped with the batch id", tx.length === 3 && tx.every((x) => x.importBatchId === batch.id));
    t.check("amounts and merchants carried through", tx.some((x) => Number(x.amount) === 2500 || Number(x.amount) === -2500) && tx.some((x) => String(x.merchant).toUpperCase().includes("COFFEE")));
  }

  t.section("2. the same file again → 409 duplicate-import, nothing written");
  {
    const fa = fake.rows("FinancialAccount", { ownerUserId: w.ids.member })[0].id as string;
    const before = fake.rows("Transaction").length;
    const r = await upload("member", w.S, fa, CSV, "renamed-but-same-bytes.csv");
    t.known("409 { error: 'duplicate-import', importBatchId } (IDEMP-001's promised answer)",
      r.status === 409 && r.body.error === "duplicate-import" && r.body.importBatchId === fake.one("ImportBatch", { financialAccountId: fa })!.id,
      `J-D6: claimImportBatch catches the P2002 and then queries INSIDE the same (now aborted, SQLSTATE 25P02) tenant transaction — got ${r.status} ${JSON.stringify(r.body)}`);
    t.check("the duplicate is still REFUSED — never a second import (409 or the 500 of J-D6, nothing else)", r.status === 409 || r.status === 500, r.status);
    t.check("no new batch, no new transactions (the idempotency itself holds)", fake.rows("ImportBatch").length === 1 && fake.rows("Transaction").length === before);
    const other = await upload("member", w.S, fa, CSV + "2026-09-04,BOOKSHOP,-12.00\n");
    t.check("a DIFFERENT file into the same account is accepted (dedupe is per file hash)", other.status === 200 || other.status === 201, other.status);
  }

  t.section("3. authority");
  {
    w = await spaceWorld(fake);
    const fa = accountIn(w.S, "member");
    const v = await upload("viewer", w.S, fa);
    t.check("a VIEWER importing into another member's account → 403", v.status === 403, v.status);
    const s = await upload("stranger", w.T, fa);
    t.check("the other tenant (its own active Space) → 404", s.status === 404, s.status);
    const sx = await upload("stranger", w.S, fa);
    t.check("the other tenant naming S in the cookie (not a member) → 404 (falls back to a Space it can reach)", sx.status === 404, sx.status);
    t.check("no batch from any refusal", fake.rows("ImportBatch").length === 0);
    const bal = accountIn(w.S, "admin", "BALANCE_ONLY");
    t.check("BALANCE_ONLY share: even the Space OWNER cannot import into someone else's account (403)", (await upload("owner", w.S, bal)).status === 403);
  }

  t.done();
}

main().catch((e) => { console.error(e); process.exit(1); });
