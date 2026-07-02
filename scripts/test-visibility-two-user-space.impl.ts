/**
 * scripts/test-visibility-two-user-space.impl.ts
 *
 * KD-1 + KD-15 end-to-end privacy regression — two-user shared Space. TEST BODY.
 *
 * KD-1 covers the AI-context assembler path; KD-15 (block 6 below) covers the UI
 * read paths (lib/data/transactions.ts and the account-modal route decision)
 * against the identical seeded scenario, so AI and UI cannot disagree on what a
 * BALANCE_ONLY / SUMMARY_ONLY / REVOKED account may expose.
 *
 * DO NOT run this file directly. Run the launcher, which installs the
 * `server-only` resolver shim before any app module loads:
 *
 *     npx tsx scripts/test-visibility-two-user-space.ts
 *
 * (`server-only` is a Next.js-compiler-internal alias, not an installed
 * package — several lib/ modules in this import chain declare it, so a
 * standalone runtime needs the shim. See the launcher header.)
 *
 * Seeds a real two-user shared Space in the connected database, runs the real
 * assembler pipeline, and asserts the BALANCE_ONLY / SUMMARY_ONLY / REVOKED
 * privacy guarantees at the STRING level over the full serialized context —
 * so future payload additions cannot silently reintroduce the leak.
 *
 * ── Pipeline fidelity ─────────────────────────────────────────────────────────
 * This replicates buildContext() step 4 exactly: resolve the PERSONAL domain
 * manifest, run every registered assembler, then run signal detectors — the
 * same modules, the same DB queries. This is faithful to the unit under test:
 * KD-1 lives entirely in the assembler queries. What is NOT exercised here is
 * buildContext()'s membership guard and audit-log write; both are unchanged
 * by KD-1 and remain covered in lib/ai/context-builder.ts.
 *
 * All seeded rows carry a unique run ID and are deleted in a finally block,
 * pass or fail.
 *
 * Scenario:
 *   User A (member) + User B (account owner) share a Space. B links four
 *   accounts, each with a sentinel "canary" merchant in its transactions:
 *     X — FULL link          → canary MUST appear in AI context
 *     Y — BALANCE_ONLY link  → canary MUST NOT appear; balance MUST appear
 *     Z — SUMMARY_ONLY link  → canary MUST NOT appear
 *     W — REVOKED FULL link  → canary MUST NOT appear (status enforced
 *                              independently of visibility)
 *
 * Assertions (exit 1 on any failure):
 *   1. TRANSACTIONS_SUMMARY contains canary X
 *   2. Full serialized context contains no canary Y / Z / W (string scan)
 *   3. Money totals equal account X's transactions exactly
 *   4. Accounts domain still reports Y's balance (no over-redaction)
 *   5. Drilldown surfaces only X rows
 */

import {
  PrismaClient,
  AccountOwnerType,
  AccountType,
  ShareStatus,
  SpaceAccountLinkKind,
  SpaceCategory,
  SpaceMemberRole,
  SpaceType,
  TransactionCategory,
  VisibilityLevel,
} from '@prisma/client';

// Side-effect import: registers all assemblers (same bootstrap buildContext uses).
import '@/lib/ai/assemblers';

import { getAssembler } from '@/lib/ai/assembler-registry';
import { getDomainManifest } from '@/lib/ai/domain-manifest';
import { runSignalDetectors } from '@/lib/ai/signals';
// KD-15: the real UI list read path + the predicate the account-modal route uses.
import { getTransactions } from '@/lib/data/transactions';
// KD-19: the real UI account + holdings read paths.
import { getAccounts, getHoldings } from '@/lib/data/accounts';
import { grantsTransactionDetail } from '@/lib/ai/visibility';
import { FinanceDomains } from '@/lib/ai/types';
import type {
  AssemblerOptions,
  ContextDomainSection,
  TransactionsSummaryData,
} from '@/lib/ai/types';
import type { SpaceContext } from '@/lib/space'; // type-only — erased at runtime

const prisma = new PrismaClient();

// Canary base tokens are contiguous letter strings so merchant normalization
// (case/spacing/store-number handling) cannot destroy them; scans are
// case-insensitive.
const RUN_ID = `${Date.now()}`;
const CANARY_X = `LEAKCANARYX ${RUN_ID}`;
const CANARY_Y = `LEAKCANARYY ${RUN_ID}`;
const CANARY_Z = `LEAKCANARYZ ${RUN_ID}`;
const CANARY_W = `LEAKCANARYW ${RUN_ID}`;

// KD-19 — per-account institution canaries (identifying metadata that
// BALANCE_ONLY / SUMMARY_ONLY must redact from getAccounts()), and per-position
// holding-symbol canaries (per-item detail getHoldings() must gate on FULL).
const INST_X = `INSTCANARYX${RUN_ID}`;
const INST_Y = `INSTCANARYY${RUN_ID}`;
const INST_Z = `INSTCANARYZ${RUN_ID}`;
const INST_W = `INSTCANARYW${RUN_ID}`;
const HOLD_X = `HOLDCANARYX${RUN_ID}`; // on FULL account X → must appear
const HOLD_Y = `HOLDCANARYY${RUN_ID}`; // on BALANCE_ONLY account Y → must not

const Y_BALANCE = 7777.77;

let failures = 0;

function check(name: string, ok: boolean, detail?: string): void {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}`);
  if (!ok) {
    failures++;
    if (detail) console.log(`        ${detail}`);
  }
}

function daysAgo(n: number): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/**
 * Replica of buildContext() step 4 (assemble) + step 5 (signals), minus the
 * membership guard and audit write (see file header). Assemblers consume only
 * spaceId (+ userId in accounts.ts) from SpaceContext, so a minimal context
 * object is sufficient; the cast is confined to this test helper.
 */
async function assembleFullContext(
  spaceId: string,
  userId:  string,
  options: AssemblerOptions,
): Promise<{ domains: Record<string, ContextDomainSection>; signals: unknown[] }> {
  const spaceCtx = { spaceId, userId } as unknown as SpaceContext;
  const domains: Record<string, ContextDomainSection> = {};

  for (const domain of getDomainManifest('PERSONAL')) {
    const assembler = getAssembler(domain);
    if (!assembler) continue;
    const section = await assembler(spaceCtx, options);
    if (section !== null) domains[domain] = section;
  }

  const signals = runSignalDetectors(domains, spaceId);
  return { domains, signals };
}

async function main(): Promise<void> {
  // ── Seed ──────────────────────────────────────────────────────────────────

  const userA = await prisma.user.create({
    data: { email: `kd1-test-a-${RUN_ID}@example.test`, name: 'KD1 Test A' },
  });
  const userB = await prisma.user.create({
    data: { email: `kd1-test-b-${RUN_ID}@example.test`, name: 'KD1 Test B' },
  });

  const space = await prisma.space.create({
    data: {
      name:     `KD1 Test Space ${RUN_ID}`,
      type:     SpaceType.SHARED,
      category: SpaceCategory.PERSONAL,
      members: {
        create: [
          { userId: userA.id, role: SpaceMemberRole.OWNER },
          { userId: userB.id, role: SpaceMemberRole.MEMBER },
        ],
      },
      aiAgent: { create: { name: `KD1 Test Agent ${RUN_ID}`, agentScope: [] } },
    },
  });

  const mkAccount = (name: string, balance: number, institution: string) =>
    prisma.financialAccount.create({
      data: {
        ownerType:   AccountOwnerType.USER,
        ownerUserId: userB.id,
        name,
        type:        AccountType.checking,
        institution,
        balance,
      },
    });

  const [acctX, acctY, acctZ, acctW] = await Promise.all([
    mkAccount(`KD1 X ${RUN_ID}`, 1000,      INST_X),
    mkAccount(`KD1 Y ${RUN_ID}`, Y_BALANCE, INST_Y),
    mkAccount(`KD1 Z ${RUN_ID}`, 2000,      INST_Z),
    mkAccount(`KD1 W ${RUN_ID}`, 3000,      INST_W),
  ]);

  const mkLink = (financialAccountId: string, visibilityLevel: VisibilityLevel, status: ShareStatus) =>
    prisma.spaceAccountLink.create({
      data: {
        spaceId: space.id,
        financialAccountId,
        kind:          SpaceAccountLinkKind.SHARED,
        addedByUserId: userB.id,
        visibilityLevel,
        status,
        ...(status === ShareStatus.REVOKED
          ? { revokedAt: new Date(), revokedByUserId: userB.id }
          : {}),
      },
    });

  await Promise.all([
    mkLink(acctX.id, VisibilityLevel.FULL,         ShareStatus.ACTIVE),
    mkLink(acctY.id, VisibilityLevel.BALANCE_ONLY, ShareStatus.ACTIVE),
    mkLink(acctZ.id, VisibilityLevel.SUMMARY_ONLY, ShareStatus.ACTIVE),
    mkLink(acctW.id, VisibilityLevel.FULL,         ShareStatus.REVOKED),
  ]);

  await prisma.transaction.createMany({
    data: [
      // X (FULL) — the only rows allowed into AI context.
      { financialAccountId: acctX.id, date: daysAgo(5),  merchant: CANARY_X, category: TransactionCategory.Income,    amount:  5000.0 },
      { financialAccountId: acctX.id, date: daysAgo(10), merchant: CANARY_X, category: TransactionCategory.Dining,    amount:  -123.45 },
      // Y (BALANCE_ONLY) — must never appear.
      { financialAccountId: acctY.id, date: daysAgo(6),  merchant: CANARY_Y, category: TransactionCategory.Groceries, amount:  -777.77 },
      // Z (SUMMARY_ONLY) — must never appear.
      { financialAccountId: acctZ.id, date: daysAgo(7),  merchant: CANARY_Z, category: TransactionCategory.Shopping,  amount:  -888.88 },
      // W (REVOKED, FULL) — must never appear.
      { financialAccountId: acctW.id, date: daysAgo(8),  merchant: CANARY_W, category: TransactionCategory.Travel,    amount:  -999.99 },
    ],
  });

  // KD-19 — one position on the FULL account X (must surface in getHoldings)
  // and one on the BALANCE_ONLY account Y (positions are per-item detail — must
  // NOT surface, even though Y's balance is still exposed via getAccounts).
  await prisma.holding.createMany({
    data: [
      { financialAccountId: acctX.id, symbol: HOLD_X, name: HOLD_X, quantity: 1, price: 10, value: 10 },
      { financialAccountId: acctY.id, symbol: HOLD_Y, name: HOLD_Y, quantity: 1, price: 20, value: 20 },
    ],
  });

  // ── Exercise the real assembler pipeline ──────────────────────────────────

  const context = await assembleFullContext(space.id, userA.id, { scopeHint: 'full' });
  const serialized = JSON.stringify(context).toLowerCase();

  const txnSection = context.domains[FinanceDomains.TRANSACTIONS_SUMMARY];
  const txnJson    = txnSection ? JSON.stringify(txnSection).toLowerCase() : '';
  const txnData    = txnSection?.data as TransactionsSummaryData | undefined;

  // 1. FULL-visibility rows are present.
  check(
    'TRANSACTIONS_SUMMARY assembled and contains canary X (FULL link)',
    txnJson.includes('leakcanaryx'),
    txnSection ? 'canary X missing from transactions summary' : 'transactions_summary domain missing entirely',
  );

  // 2. String-level scan of the ENTIRE context — no field is exempt.
  check('full context contains no canary Y (BALANCE_ONLY)', !serialized.includes('leakcanaryy'));
  check('full context contains no canary Z (SUMMARY_ONLY)', !serialized.includes('leakcanaryz'));
  check('full context contains no canary W (REVOKED FULL)', !serialized.includes('leakcanaryw'));

  // 3. Money totals reconcile to account X exactly — excluded accounts'
  //    amounts must not inflate any aggregate.
  check(
    `incomeTotal equals X income exactly (5000)`,
    txnData?.incomeTotal === 5000,
    `actual: ${txnData?.incomeTotal}`,
  );
  check(
    `expenseTotal equals X expense exactly (123.45)`,
    txnData?.expenseTotal === 123.45,
    `actual: ${txnData?.expenseTotal} — Y (-777.77) / Z (-888.88) / W (-999.99) may be leaking into aggregates`,
  );

  // 4. No over-redaction: BALANCE_ONLY still grants the balance via the
  //    accounts assembler.
  const acctSection = context.domains[FinanceDomains.ACCOUNTS];
  const acctJson    = acctSection ? JSON.stringify(acctSection) : '';
  check(
    "accounts domain still reports Y's balance (BALANCE_ONLY grants balance)",
    acctJson.includes('"BALANCE_ONLY"') && acctJson.includes(String(Y_BALANCE)),
    'BALANCE_ONLY entry or its balance missing — fix may be over-redacting',
  );

  // 5. Drilldown surfaces only FULL rows. The merchant filter matches every
  //    canary ("LEAKCANARY", case-insensitive contains) — visibility alone
  //    must exclude Y/Z/W.
  const drillContext = await assembleFullContext(space.id, userA.id, {
    scopeHint: 'full',
    drilldown: { merchant: 'LEAKCANARY' },
  });
  const drillSection = drillContext.domains[FinanceDomains.TRANSACTIONS_SUMMARY];
  const drillJson    = drillSection ? JSON.stringify(drillSection).toLowerCase() : '';
  check(
    'drilldown returns canary X rows only',
    drillJson.includes('leakcanaryx') &&
      !drillJson.includes('leakcanaryy') &&
      !drillJson.includes('leakcanaryz') &&
      !drillJson.includes('leakcanaryw'),
  );

  // ── 6. KD-15 — UI read paths ──────────────────────────────────────────────
  // The dashboard/banking list read path (lib/data/transactions.ts) must obey
  // the SAME visibility rule as the AI context. Same seeded scenario:
  //   X FULL → rows visible · Y BALANCE_ONLY / Z SUMMARY_ONLY / W REVOKED → none.
  const uiRows = await getTransactions({ spaceId: space.id });
  const uiJson = JSON.stringify(uiRows).toLowerCase();

  check(
    'getTransactions() returns canary X rows (FULL link)',
    uiJson.includes('leakcanaryx'),
    'FULL-visibility rows missing from the UI list — fix may be over-redacting',
  );
  check(
    'getTransactions() leaks no canary Y (BALANCE_ONLY)',
    !uiJson.includes('leakcanaryy'),
    'BALANCE_ONLY transaction rows leaked into the UI list',
  );
  check(
    'getTransactions() leaks no canary Z (SUMMARY_ONLY)',
    !uiJson.includes('leakcanaryz'),
    'SUMMARY_ONLY transaction rows leaked into the UI list',
  );
  check(
    'getTransactions() leaks no canary W (REVOKED FULL)',
    !uiJson.includes('leakcanaryw'),
    'REVOKED link transaction rows leaked into the UI list',
  );

  // Account-modal route decision (app/api/accounts/[id]/transactions/route.ts):
  // its gate accepts any ACTIVE link, then returns rows only when the link
  // grants transaction detail. Validate that decision against the real seeded
  // links: X → detail granted (rows), Y/Z → active but detail withheld (empty
  // list, not 404). This is the exact predicate the handler branches on.
  const links = await prisma.spaceAccountLink.findMany({
    where:  { spaceId: space.id, status: ShareStatus.ACTIVE },
    select: { financialAccountId: true, visibilityLevel: true },
  });
  const linkFor = (id: string) => links.find((l) => l.financialAccountId === id);

  check(
    'modal route would return rows for account X (FULL link grants detail)',
    grantsTransactionDetail(linkFor(acctX.id)!.visibilityLevel),
  );
  check(
    'modal route would return an empty list for account Y (BALANCE_ONLY link, active but no detail)',
    linkFor(acctY.id) !== undefined && !grantsTransactionDetail(linkFor(acctY.id)!.visibilityLevel),
  );
  check(
    'modal route would return an empty list for account Z (SUMMARY_ONLY link, active but no detail)',
    linkFor(acctZ.id) !== undefined && !grantsTransactionDetail(linkFor(acctZ.id)!.visibilityLevel),
  );

  // ── 7. KD-19 — UI account metadata read path (lib/data/accounts.ts) ────────
  // getAccounts() must obey the SAME visibility rule: FULL exposes real name +
  // institution + debt metadata; BALANCE_ONLY / SUMMARY_ONLY expose the balance
  // total only (generic name, no institution/debt fields); REVOKED links are
  // absent entirely. Account balances are unique per account, so rows are
  // identified by balance.
  // userId is passed explicitly: getAccounts() otherwise resolves it via
  // getSpaceContext() (next-auth headers()), which cannot run in this
  // standalone tsx harness. userA is the *viewer* (the non-owner member), so
  // this exercises the cross-member visibility path.
  const accts    = await getAccounts({ spaceId: space.id, userId: userA.id });
  const acctsUi  = JSON.stringify(accts).toLowerCase();
  const rowFor   = (bal: number) => accts.find((a) => a.balance === bal);
  const rowX = rowFor(1000), rowY = rowFor(Y_BALANCE), rowZ = rowFor(2000), rowW = rowFor(3000);

  check(
    'getAccounts() exposes FULL account X institution + real name',
    !!rowX && rowX.institution === INST_X && rowX.name.includes('KD1 X'),
    `rowX institution=${rowX?.institution} name=${rowX?.name}`,
  );
  check(
    'getAccounts() reports Y balance (BALANCE_ONLY grants the balance total — no over-redaction)',
    !!rowY,
    'BALANCE_ONLY account Y missing entirely — fix is over-redacting the balance',
  );
  check(
    'getAccounts() redacts Y institution (BALANCE_ONLY)',
    !!rowY && rowY.institution !== INST_Y && !acctsUi.includes(INST_Y.toLowerCase()),
    `rowY institution leaked: ${rowY?.institution}`,
  );
  check(
    'getAccounts() redacts Y real name (BALANCE_ONLY)',
    !!rowY && !rowY.name.includes('KD1 Y'),
    `rowY name leaked: ${rowY?.name}`,
  );
  check(
    'getAccounts() redacts Z institution + real name (SUMMARY_ONLY)',
    !!rowZ && rowZ.institution !== INST_Z && !rowZ.name.includes('KD1 Z') && !acctsUi.includes(INST_Z.toLowerCase()),
    `rowZ institution=${rowZ?.institution} name=${rowZ?.name}`,
  );
  check(
    'getAccounts() excludes REVOKED account W entirely',
    !rowW && !acctsUi.includes(INST_W.toLowerCase()),
    'REVOKED link account leaked into the UI account list',
  );

  // ── 8. KD-19 — UI holdings read path (positions are per-item detail) ───────
  const holdings   = await getHoldings({ spaceId: space.id });
  const holdingsUi = JSON.stringify(holdings).toLowerCase();
  check(
    'getHoldings() surfaces positions from FULL account X',
    holdingsUi.includes(HOLD_X.toLowerCase()),
    'FULL-visibility position missing — fix is over-redacting holdings',
  );
  check(
    'getHoldings() leaks no positions from BALANCE_ONLY account Y',
    !holdingsUi.includes(HOLD_Y.toLowerCase()),
    'BALANCE_ONLY position leaked into the UI holdings list',
  );
}

async function cleanup(): Promise<void> {
  // Order matters only where cascades don't cover us (AuditLog written by
  // buildContext). Everything is scoped to this run's rows.
  const spaces = await prisma.space.findMany({
    where: { name: `KD1 Test Space ${RUN_ID}` },
    select: { id: true },
  });
  const spaceIds = spaces.map((s) => s.id);

  if (spaceIds.length > 0) {
    await prisma.auditLog.deleteMany({ where: { spaceId: { in: spaceIds } } });
  }
  // FinancialAccount deletes cascade Transactions; Space deletes cascade
  // members, links, and the AiAgent.
  await prisma.financialAccount.deleteMany({ where: { name: { contains: RUN_ID } } });
  if (spaceIds.length > 0) {
    await prisma.space.deleteMany({ where: { id: { in: spaceIds } } });
  }
  await prisma.user.deleteMany({ where: { email: { contains: `-${RUN_ID}@example.test` } } });
}

main()
  .catch((e) => {
    failures++;
    console.error('TEST RUN FAILED:', e instanceof Error ? e.stack ?? e.message : e);
  })
  .finally(async () => {
    try {
      await cleanup();
      console.log('\n(seeded rows cleaned up)');
    } catch (e) {
      console.error('CLEANUP FAILED — seeded KD1 test rows may remain:', e);
      failures++;
    }
    await prisma.$disconnect();
    console.log('');
    console.log(failures === 0 ? 'All KD-1 + KD-15 + KD-19 end-to-end privacy cases passed.' : `${failures} failure(s).`);
    process.exit(failures === 0 ? 0 : 1);
  });
