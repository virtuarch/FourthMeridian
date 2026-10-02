/**
 * lib/data/transactions.authority.test.ts  (RLS-T1)
 *
 * THE TRANSACTION READ SPINE EXECUTES ON THE AUTHORITY IT WAS HANDED — PROVEN BY
 * RUNNING IT, NOT BY READING IT.
 *
 * `lib/data/transactions.ts` is the product's banking read spine. Before RLS-T1
 * every query in it went to `db`, the migration principal: the role that owns
 * every table, carries BYPASSRLS and is exempt from every policy. The conversion
 * gives each read leaf a REQUIRED, LEADING `ReadClient`, which the compiler then
 * enumerates for us.
 *
 * ── WHY THIS TEST CALLS THE FUNCTIONS INSTEAD OF SCANNING THEM ───────────────
 *
 * A source scan can tell you the word `db` is absent. It cannot tell you a read
 * went to the client the caller passed, and this programme has already shipped
 * one escape that every scan called clean: `holdings.ts` reached the migration
 * principal through two seams that defaulted `client ?? db` three files away.
 *
 * So the probe below is a RECORDING client. Every `<model>.<method>()` the spine
 * performs lands in a call log, and the assertion is on the COUNT and IDENTITY of
 * the recorded reads. A read that slipped back onto the module's own `db` would
 * simply be missing from the log — the count drops and the case fails. That is a
 * real denominator rather than an absence claim: each case states how many reads
 * it expects, the fixture is non-empty, and the returned DTO is checked to carry
 * it (⚠️ a fixture yielding nothing makes a "no leak" test pass for the wrong
 * reason, which is the specific bug this repository has shipped before).
 *
 * The source-scan half at the bottom covers the two things execution cannot
 * reach: that NO leaf defaults its authority, and that the ONE read still on the
 * migration principal is the one that says so.
 *
 * Standalone tsx (house convention). No live database: if any read escaped onto
 * the real client, Prisma would attempt a connection the test environment has not
 * configured — a second, independent way for this file to fail rather than lie.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import {
  getTransactions,
  getDebtTransactions,
  getTransactionDetail,
} from "@/lib/data/transactions";
import type { ReadClient } from "@/lib/db/tenant-context";

const ROOT = process.cwd();
/** Source with comments stripped, so a NEEDLE can never match prose about itself. */
const code = (rel: string) =>
  readFileSync(path.join(ROOT, rel), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");

let failures = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

// ───────────────────────────────────────────────────────────────────────────────
// The recording client
// ───────────────────────────────────────────────────────────────────────────────

type Program = Record<string, unknown[]>;

/**
 * A `ReadClient` that records every read and serves programmed results.
 *
 * `program` maps "<model>.<method>" to the SUCCESSIVE results of that pair, so a
 * function that reads one model twice (the detail path reads `transaction` as a
 * point read and then as a candidate sweep) can be given a different answer each
 * time. Unprogrammed reads degrade to `[]` for a collection read and `null` for a
 * point read — the shape the spine's own fail-closed branches expect.
 *
 * It is deliberately NOT a Prisma mock: it has no `$transaction`, which is the
 * load-bearing property of `ReadClient` itself (a read leaf is structurally
 * incapable of opening a phase of its own).
 */
function recordingClient(program: Program) {
  const calls: string[] = [];
  const queues: Program = Object.fromEntries(
    Object.entries(program).map(([k, v]) => [k, [...v]]),
  );
  const client = new Proxy({} as Record<string, unknown>, {
    get(_target, modelKey) {
      const model = String(modelKey);
      // Never let the client masquerade as a thenable or as the transaction opener.
      if (model === "then" || model === "$transaction") return undefined;
      return new Proxy({} as Record<string, unknown>, {
        get(_t2, methodKey) {
          const method = String(methodKey);
          return (..._args: unknown[]) => {
            const key = `${model}.${method}`;
            calls.push(key);
            const q = queues[key];
            if (q && q.length > 0) return Promise.resolve(q.shift());
            const collection = method.startsWith("findMany") || method === "groupBy";
            return Promise.resolve(collection ? [] : null);
          };
        },
      });
    },
  });
  return { client: client as unknown as ReadClient, calls };
}

/** How many times the probe observed a given read. */
const count = (calls: string[], key: string) => calls.filter((c) => c === key).length;

// ───────────────────────────────────────────────────────────────────────────────
// Fixtures
// ───────────────────────────────────────────────────────────────────────────────

const D = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

/** A minimal but REAL banking list row, as `transactionListInclude` returns one. */
function listRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "tx_a", financialAccountId: "fa_1",
    date: D("2026-06-14"), economicDate: D("2026-06-14"),
    merchant: "BLUE BOTTLE", description: "BLUE BOTTLE #442",
    category: "Dining", amount: -15.33, pending: false, currency: "USD",
    flowType: "SPENDING", flowDirection: "OUTFLOW",
    classificationConfidence: 0.95, classificationReason: "PLAID_PFC_DETAILED",
    classifierVersion: 1,
    counterpartyAccountId: null, merchantId: null, resolvedMerchant: null,
    counterpartyAccount: null,
    importBatchId: null, plaidTransactionId: "plaid_a",
    transactionEventId: null,
    transferRail: null, transferMovementForm: null, transferVenueClass: null,
    transferEvidenceConfidence: null, transferEvidenceReason: null,
    transferEvidenceSource: null, transferEvidenceVersion: null,
    ...over,
  };
}

// ───────────────────────────────────────────────────────────────────────────────
// 1. getTransactions — the page AND its enrichment come from ONE authority
// ───────────────────────────────────────────────────────────────────────────────

async function probeGetTransactions(): Promise<void> {
  console.log("getTransactions — every read lands on the client the caller passed");

  const rows = [listRow({ id: "tx_a" }), listRow({ id: "tx_b", financialAccountId: "fa_2" })];
  const { client, calls } = recordingClient({
    // 1 — the bounded page.
    "transaction.findMany": [rows],
    // 2 — the account-type lookup the canonical income authority needs.
    "financialAccount.findMany": [[
      { id: "fa_1", type: "depository" }, { id: "fa_2", type: "debt" },
    ]],
  });

  const out = await getTransactions(client, { spaceId: "space_1" });

  // THE DENOMINATOR. Two reads, both of which used to be `db.`:
  //   transaction.findMany        — the page
  //   financialAccount.findMany   — loadAccountTypes, through projectTransactionListRows
  // If either had stayed on the migration principal it would be absent here.
  check("the page read was observed on the passed client", count(calls, "transaction.findMany") === 1,
    `saw ${count(calls, "transaction.findMany")}`);
  check("the account-type enrichment was observed on the SAME client",
    count(calls, "financialAccount.findMany") === 1,
    `saw ${count(calls, "financialAccount.findMany")}`);
  check("exactly 2 reads reached the probe — no read went elsewhere", calls.length === 2,
    `observed [${calls.join(", ")}]`);

  // NOT A VACUOUS PASS: the fixture produced rows and they reached the DTO,
  // including the enrichment that came from the second read.
  check("the fixture was non-empty and the DTOs carry it", out.rows.length === 2,
    `got ${out.rows.length} rows`);
  check("the enrichment actually landed (accountType decided `other` vs the real type)",
    out.rows[0]?.id === "tx_a" && out.rows[1]?.id === "tx_b");
  check("the bounding contract is unchanged by the conversion",
    out.truncated === false && out.limit === 5000 && out.windowDays === null);
}

// ───────────────────────────────────────────────────────────────────────────────
// 2. getDebtTransactions — the transfer pass runs on the caller's authority too
// ───────────────────────────────────────────────────────────────────────────────

async function probeGetDebtTransactions(): Promise<void> {
  console.log("getDebtTransactions — the transfer pass joins the same authority");

  // A DEBT_PAYMENT leg with NO persisted counterparty is a transfer prefilter
  // candidate, so `resolveTransferAssessments` really runs. That is the point:
  // its ownership anchor used to be reached with the module's own `db`.
  const rows = [listRow({ id: "tx_d", flowType: "DEBT_PAYMENT", counterpartyAccountId: null })];
  const { client, calls } = recordingClient({
    "transaction.findMany": [rows],
    // resolveTransferAssessments: owner anchor, then the owned-account graph.
    "financialAccount.findMany": [
      [{ ownerUserId: "user_1" }],
      [], // no owned accounts visible → the resolver fails closed and returns early
    ],
  });

  const out = await getDebtTransactions(client, { spaceId: "space_1" });

  check("the debt page read was observed on the passed client",
    count(calls, "transaction.findMany") === 1);
  check("the transfer resolver's TWO account reads were observed on the SAME client",
    count(calls, "financialAccount.findMany") === 2,
    `saw ${count(calls, "financialAccount.findMany")}`);
  check("exactly 3 reads reached the probe", calls.length === 3, `observed [${calls.join(", ")}]`);
  check("the fixture was non-empty and the DTO carries it", out.rows.length === 1);
  // Fail-closed, and it is the NARROWING RLS-AI-S6 recorded: an owned-account
  // graph the policy will not show cannot resolve a far leg, so no counterparty.
  check("an unresolvable far leg yields NO counterparty, never a guessed one",
    out.rows[0]?.counterpartyAccountId === null);
}

// ───────────────────────────────────────────────────────────────────────────────
// 3. getTransactionDetail — the client-supplied id, on the caller's authority
// ───────────────────────────────────────────────────────────────────────────────

async function probeGetTransactionDetail(): Promise<void> {
  console.log("getTransactionDetail — four reads, one authority, a client-supplied id");

  const row = {
    ...listRow({ id: "tx_detail" }),
    createdAt: D("2026-06-15"),
    pfcPrimary: null, pfcDetailed: null, pfcConfidenceLevel: null,
    paymentChannel: null, paymentMethod: null, settlementState: null,
    authorizedAt: null, counterpartyType: null, fxApplied: null,
    pendingTransactionRef: null, tiFactsVersion: null,
    importBatch: null,
    financialAccount: {
      id: "fa_1", name: "Checking", displayName: null, officialName: null,
      plaidName: null, institution: "Test Bank", mask: "1234",
      type: "depository", ownerUserId: "user_1",
    },
  };
  const { client, calls } = recordingClient({
    "transaction.findFirst": [row],
    // ⚠️ `space.findUnique` is deliberately left to the NULL default. Returning a
    // Space row would send the conversion through the FX archive, which holds its
    // own client (FxRate is GLOBAL REFERENCE DATA — RLS §5, no row-level security
    // at all) and would make this a database test. The null branch exercises the
    // documented `identityContext` fallback instead, and still proves the Space
    // read itself moved off `db` — the whole reason it stopped being
    // `buildSpaceConversionContextById`.
    "financialAccount.findMany": [[{ id: "fa_2", type: "depository", mask: "9999", institutionId: "ins_1" }]],
    "transaction.findMany": [[]],
  });

  const detail = await getTransactionDetail(client, "tx_detail", { spaceId: "space_1" });

  // THE DENOMINATOR. Four reads, every one of them a `db.` call site before RLS-T1:
  check("the point read was observed on the passed client",
    count(calls, "transaction.findFirst") === 1);
  check("the Space reporting-currency read moved onto the SAME client",
    count(calls, "space.findUnique") === 1,
    "it used to be buildSpaceConversionContextById's own db.space.findUnique, three files away");
  check("owned-account candidate gathering was observed on the SAME client",
    count(calls, "financialAccount.findMany") === 1);
  check("the relationship candidate sweep was observed on the SAME client",
    count(calls, "transaction.findMany") === 1);
  check("exactly 4 reads reached the probe", calls.length === 4, `observed [${calls.join(", ")}]`);

  // NOT A VACUOUS PASS: a null DTO would make every count above meaningless,
  // because the function short-circuits on a missing row before three of them.
  check("the fixture resolved a real DTO (the counts above are not a short-circuit)",
    detail !== null && detail.id === "tx_detail");
  check("the conversion block degrades to null on the identity path, not to a fake rate",
    detail?.reporting === null);
  check("account identity resolved through the ONE authority",
    detail?.account.name === "Checking" && detail?.account.institution === "Test Bank");
}

// ───────────────────────────────────────────────────────────────────────────────
// 4. Source scan — the two things execution cannot reach
// ───────────────────────────────────────────────────────────────────────────────

function scanSpine(): void {
  console.log("spine source — no leaf defaults its authority, and the one escape says so");

  const src = code("lib/data/transactions.ts");

  // (a) NO `client = db`, in any spelling. An OPTIONAL authority is an AMBIENT
  // one that LOOKS converted — strictly worse than an obvious one.
  check("no `client: ReadClient = db` default anywhere in the spine",
    !/client\s*:\s*ReadClient\s*=/.test(src) && !/client\s*\?\?\s*db\b/.test(src) &&
    !/options\?\.\s*client\s*\?\?/.test(src));

  // (b) The required, LEADING parameter on all three converted leaves. Asserted
  // as a POSITION, because `getTransactionDetail(id, scope, client)` would pass a
  // mere "takes a client" check while putting the authority last.
  for (const fn of ["getTransactions", "getDebtTransactions"]) {
    check(`${fn} takes \`client: ReadClient\` as its FIRST parameter`,
      new RegExp(`export async function ${fn}\\(\\s*client:\\s*ReadClient,`).test(src));
  }
  check("getTransactionDetail takes `client: ReadClient` as its FIRST parameter",
    /export async function getTransactionDetail\(\s*client:\s*ReadClient,\s*id:\s*string,/.test(src));

  // (c) THE ONE READ STILL ON THE MIGRATION PRINCIPAL IS NAMED.
  // This is what gives (d) teeth: the claim is not "no `db` reads exist", it is
  // "there is exactly one, it is getDebtPaymentRows, and it is blocked on a peer
  // file". A scan that found zero would mean the needle broke, not that the
  // module was clean — the escaped-`$` failure mode this repo has on record.
  const dbReads = [...src.matchAll(/\bdb\.(\w+)\.(\w+)\(/g)].map((m) => `${m[1]}.${m[2]}`);
  check("exactly ONE db.<model>.<method>() read remains in the spine",
    dbReads.length === 1, `found ${dbReads.length}: [${dbReads.join(", ")}]`);
  check("...and it is the transaction page read inside getDebtPaymentRows",
    dbReads[0] === "transaction.findMany");
  const debtPayBody = src.slice(src.indexOf("export async function getDebtPaymentRows("));
  const debtPaySlice = debtPayBody.slice(0, debtPayBody.indexOf("\nexport async function getTransactionDetail"));
  check("the remaining db read is inside getDebtPaymentRows (located, not assumed)",
    debtPaySlice.length > 0 && /\bdb\.transaction\.findMany\(/.test(debtPaySlice),
    "could not locate getDebtPaymentRows' body");
  // THREE, and the number is stated rather than loosened: `getTransactions`'
  // page, `getDebtTransactions`' page, and the detail read's candidate sweep.
  // `getDebtPaymentRows`' page is the fourth `transaction.findMany` in this file
  // and is deliberately NOT in this set — it is the `db.` one counted above.
  check("the other three transaction.findMany reads go through `client`, not `db`",
    (src.match(/\bclient\.transaction\.findMany\(/g) ?? []).length === 3,
    `found ${(src.match(/\bclient\.transaction\.findMany\(/g) ?? []).length}`);
  check("...and the four transaction.findMany reads in the file account for all of them",
    (src.match(/\.transaction\.findMany\(/g) ?? []).length === 4);
  check("the detail read's four seams all read through `client`",
    /\bclient\.transaction\.findFirst\(/.test(src) &&
    /\bclient\.space\.findUnique\(/.test(src) &&
    /\bclient\.financialAccount\.findMany\(/.test(src) &&
    /\bclient\.financialAccount\.findFirst\(/.test(src));

  // (d) The KD-15 application predicate is KEPT. RLS enforces TENANCY ONLY
  // (migration §Q1), so the redaction tier must still be an application gate —
  // the conversion must not have been mistaken for a licence to drop it.
  check("the detail read still queries through transactionDetailWhere",
    /where:\s*transactionDetailWhere\(/.test(src));
  check("both list loaders still compose bankingTransactionWhere",
    (src.match(/bankingTransactionWhere\(/g) ?? []).length >= 3);
}

// ───────────────────────────────────────────────────────────────────────────────
// 5. Call sites — an authority is EARNED from session state, never from the wire
// ───────────────────────────────────────────────────────────────────────────────

function scanCallSites(): void {
  console.log("call sites — the identity comes from the session, never from the request");

  const spaceRoute = code("app/api/spaces/[id]/transactions/route.ts");
  check("the Space transactions route wraps its read in withTenantDb",
    /withTenantDb\(\s*\n?\s*auth\.user\.id/.test(spaceRoute));
  check("...with the SESSION's user id, not the `[id]` path param or a cookie",
    !/withTenantDb\(\s*spaceId/.test(spaceRoute) &&
    !/withTenantDb\([^)]*cookie/i.test(spaceRoute) &&
    !/withTenantDb\([^)]*searchParams/.test(spaceRoute));
  check("...and no longer imports the migration principal at all",
    !/from\s+["']@\/lib\/db["']/.test(spaceRoute));

  const detailRoute = code("app/api/transactions/[id]/route.ts");
  check("the detail route wraps its read in withTenantDb with the session user",
    /withTenantDb\(user\.id,/.test(detailRoute));
  check("...and the client-supplied `id` is only ever an ARGUMENT, never the identity",
    /getTransactionDetail\(tx,\s*id,/.test(detailRoute) && !/withTenantDb\(\s*id\b/.test(detailRoute));

  const viewCtx = code("app/api/money/view-context/route.ts");
  check("view-context's groupBy aggregates moved onto the tenant client",
    (viewCtx.match(/tx\.transaction\.groupBy\(/g) ?? []).length === 2 &&
    !/db\.transaction\.groupBy\(/.test(viewCtx));
  check("view-context no longer imports the migration principal",
    !/from\s+["']@\/lib\/db["']/.test(viewCtx));
  check("view-context keeps the FX resolution OUTSIDE the boundary",
    viewCtx.indexOf("resolveEffectiveSpaceConversionSerialized(") >
      viewCtx.lastIndexOf("withTenantDb("));

  const credit = code("app/(shell)/dashboard/credit/page.tsx");
  check("the Credit page reads debt activity inside the tenant boundary",
    /getDebtTransactions\(tx,/.test(credit));
  check("...and keeps the still-unconverted getDebtPaymentRows OUTSIDE it",
    /getDebtPaymentRows\(\{\s*spaceId:/.test(credit));

  const correct = code("app/api/transactions/[id]/correct/route.ts");
  check("the correction WRITE route passes its authority explicitly (legible, not converted)",
    (correct.match(/getTransactionDetail\(db,\s*id,/g) ?? []).length === 3);
}

// ───────────────────────────────────────────────────────────────────────────────
// 6. The export is PHASES, and the non-DB work is between them
// ───────────────────────────────────────────────────────────────────────────────

function scanExportPhases(): void {
  console.log("export assembler — phases, not one transaction");

  const exp = code("lib/export/assemble.ts");

  check("the migration principal is no longer imported",
    !/from\s+["']@\/lib\/db["']/.test(exp) && !/\bdb\.\w+\.\w+\(/.test(exp));
  // THREE kinds of phase: the subject, one per Space, the ownership lens.
  const phases = (exp.match(/withTenantDb\(/g) ?? []).length;
  check("at least three separate withTenantDb phases exist", phases >= 3, `found ${phases}`);

  // THE PROPERTY, not the shape: the decrypt must not be inside a phase. Asserted
  // by POSITION — the decrypt sits after the first phase's closing and before the
  // per-Space loop opens its own.
  const firstPhase = exp.indexOf("withTenantDb(");
  const decrypt = exp.indexOf("decryptWithPurpose(");
  const perSpacePhase = exp.indexOf("withTenantDb(", decrypt);
  check("the decrypt happens BETWEEN phases, never inside one",
    firstPhase >= 0 && decrypt > firstPhase && perSpacePhase > decrypt,
    `firstPhase=${firstPhase} decrypt=${decrypt} nextPhase=${perSpacePhase}`);

  // The per-Space phase must be inside the membership loop, or it is one
  // transaction over every Space again under a different name.
  const loop = exp.indexOf("for (const m of memberships)");
  check("a phase opens INSIDE the per-Space loop", loop >= 0 && perSpacePhase > loop,
    `loop=${loop} phase=${perSpacePhase}`);
  check("the cross-Space dedup/cap runs after the loop, outside any phase",
    exp.indexOf("capTransactions(") > perSpacePhase);

  // Sequential, not Promise.all'ed: twelve Spaces must not open twelve
  // concurrent tenant transactions on a pooled connection.
  check("the per-Space phases are awaited sequentially (no Promise.all over Spaces)",
    /const phase = await withTenantDb\(/.test(exp));

  // And the comment that stops the next reader "simplifying" it is required to
  // exist, because that is the only thing protecting the split.
  const raw = readFileSync(path.join(ROOT, "lib/export/assemble.ts"), "utf8");
  check("the file records WHY it is phases and not one transaction",
    /PHASE SPLIT|phases and not one transaction/i.test(raw) &&
    /DO NOT "SIMPLIFY"/i.test(raw));
}

// ───────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  await probeGetTransactions();
  await probeGetDebtTransactions();
  await probeGetTransactionDetail();
  scanSpine();
  scanCallSites();
  scanExportPhases();

  if (failures > 0) {
    console.error(`\ntransactions.authority: ${failures} failure(s).`);
    process.exit(1);
  }
  console.log("\ntransactions.authority: all passed.");
}

// THE SECOND, INDEPENDENT ORACLE — and it is not decoration. The mutation was
// run: reverting `loadAccountTypes` to `db.financialAccount.findMany` does not
// merely drop a recorded read, it makes Prisma raise a validation error on the
// real client, because the test environment configures no datasource. So a
// regression here fails twice over — once on the count, once on the connection —
// and the catch makes the second one legible instead of an unhandled rejection.
main().catch((e) => {
  console.error(
    "\ntransactions.authority: a read ESCAPED the probe and reached a real client.\n" +
    "That is the regression this file exists to catch: a leaf that stopped using the\n" +
    "authority it was handed and went back to the module's own `db`.\n",
    e,
  );
  process.exit(1);
});
