/**
 * prisma/seed.ts
 *
 * Multi-user demo world for local development.
 * Creates three regular users (Jane, John, Alex) plus the unchanged sysadmin,
 * 8 spaces, 21 accounts, ~360 transactions over 120 days, holdings,
 * goals, audit log events, and space snapshots.
 *
 * All data is entirely fictional. Run via: npx prisma db seed
 * Safe to re-run — all data is wiped and recreated cleanly.
 *
 * ─── Demo credentials ─────────────────────────────────────────────────────
 *   jane@example.com      / janesmith  →  ChangeMe123!  (USER)
 *   john@example.com      / johndoe    →  ChangeMe123!  (USER)
 *   alex@example.com      / alexchen   →  ChangeMe123!  (USER)
 *   sysadmin@example.com  / sysadmin   →  ChangeMe123!  (SYSTEM_ADMIN — DEV ONLY)
 *
 * ⚠️  DEVELOPMENT ONLY — never use these credentials in production.
 * ──────────────────────────────────────────────────────────────────────────
 */

import {
  PrismaClient,
  AccountType,
  TransactionCategory,
  PlaidItemStatus,
  SpaceMemberRole,
  UserRole,
  EmploymentStatus,
  UseCase,
  AccountOwnerType,
  ShareStatus,
  VisibilityLevel,
  SpaceAccountLinkKind,
  GoalType,
  GoalStatus,
  GoalCategory,
} from "@prisma/client";
import bcrypt from "bcryptjs";
import { encryptWithPurpose, EncryptionPurpose } from "../lib/plaid/encryption";
import { SpaceCategory } from "../lib/space-presets";
// SP-2.3 — seeded Spaces are born through the same registry/planner path as
// the register route (SP-2A-3) and POST /api/spaces (SP-2.1): the planner is
// authoritative everywhere a Space is born.
import { getTemplateForCategory } from "../lib/space-templates/registry";
import { planTemplateApplication } from "../lib/space-templates/apply";
// PO1.0 — idempotent bootstrap of the four platform Spaces (Platform/Security
// Ops, Growth & Revenue, Customer Success). Dev DBs always have them; access is
// grant-gated (no members are seeded).
import { ensurePlatformSpaces, ensurePlatformSections } from "../lib/platform/seed";

const prisma = new PrismaClient();

const JANE_PASSWORD  = process.env.SEED_USER_PASSWORD  ?? "ChangeMe123!";
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? "ChangeMe123!";

// ─── Date helpers ─────────────────────────────────────────────────────────────
const TODAY = new Date();
TODAY.setUTCHours(0, 0, 0, 0);
function D(n: number): Date {
  const d = new Date(TODAY);
  d.setDate(d.getDate() - n);
  return d;
}

// ─── Seeded deterministic random ──────────────────────────────────────────────
function seededRand(seed: number): number {
  const x = Math.sin(seed + 1) * 10000;
  return x - Math.floor(x);
}

// ─── Snapshot history generators ──────────────────────────────────────────────
function buildHistory(spaceId: string) {
  return Array.from({ length: 365 }, (_, i) => {
    const date = D(364 - i);
    const t = i / 364;
    const stocks  = Math.max(Math.round(8000  + t * 4400  + Math.sin(i * 0.09) * 500  + (seededRand(i)       - 0.5) * 400), 0);
    const crypto  = Math.max(Math.round(4000  + t * 2800  + Math.sin(i * 0.11) * 1200 + (seededRand(i + 99)  - 0.42) * 800), 0);
    const cash    = Math.max(Math.round(3800  + Math.sin(i * 0.08) * 600 + (seededRand(i + 33)  - 0.5) * 400), 0);
    const savings = Math.max(Math.round(5500  + t * 3000  + (seededRand(i + 77)  - 0.5) * 100), 0);
    const debt    = Math.abs(Math.round(5200  - t * 2000  + Math.sin(i * 0.05) * 300  + (seededRand(i + 55)  - 0.5) * 200));
    const total = stocks + crypto;
    const totalAssets = stocks + crypto + cash + savings;
    const netWorth    = totalAssets - debt;
    const netLiquid   = cash + savings - debt;
    const cashOnHand  = cash + Math.max(savings - 6000, 0);
    return { spaceId, date, stocks, crypto, total, cash, savings, debt, netWorth, totalAssets, netLiquid, cashOnHand };
  });
}

function buildJohnHistory(spaceId: string) {
  return Array.from({ length: 365 }, (_, i) => {
    const date = D(364 - i);
    const t = i / 364;
    const stocks  = Math.max(Math.round(12000 + t * 6200  + Math.sin(i * 0.09) * 800  + (seededRand(i + 200) - 0.5) * 600), 0);
    const crypto  = Math.max(Math.round(4500  + t * 2900  + Math.sin(i * 0.12) * 1500 + (seededRand(i + 300) - 0.42) * 1000), 0);
    const cash    = Math.max(Math.round(1800  + Math.sin(i * 0.07) * 400 + (seededRand(i + 133) - 0.5) * 300), 0);
    const savings = Math.max(Math.round(3000  + t * 2500  + (seededRand(i + 177) - 0.5) * 150), 0);
    const debt    = Math.abs(Math.round(22000 - t * 5000  + Math.sin(i * 0.04) * 400  + (seededRand(i + 155) - 0.5) * 300));
    const total = stocks + crypto;
    const totalAssets = stocks + crypto + cash + savings;
    const netWorth    = totalAssets - debt;
    const netLiquid   = cash + savings - debt;
    const cashOnHand  = Math.max(cash + Math.max(savings - 8000, 0), 0);
    return { spaceId, date, stocks, crypto, total, cash, savings, debt, netWorth, totalAssets, netLiquid, cashOnHand };
  });
}

function buildHouseholdHistory(spaceId: string) {
  return Array.from({ length: 120 }, (_, i) => {
    const date = D(119 - i);
    const t = i / 119;
    const stocks  = Math.max(Math.round(29000 + t * 8000  + Math.sin(i * 0.09) * 1200 + (seededRand(i + 500) - 0.5) * 800), 0);
    const crypto  = Math.max(Math.round(12000 + t * 5500  + Math.sin(i * 0.11) * 2000 + (seededRand(i + 600) - 0.42) * 1200), 0);
    const cash    = Math.max(Math.round(5000  + Math.sin(i * 0.08) * 800  + (seededRand(i + 700) - 0.5) * 500), 0);
    const savings = Math.max(Math.round(14000 + t * 4000  + (seededRand(i + 800) - 0.5) * 200), 0);
    const debt    = Math.abs(Math.round(26000 - t * 4000  + (seededRand(i + 900) - 0.5) * 300));
    const total = stocks + crypto;
    const totalAssets = stocks + crypto + cash + savings;
    const netWorth    = totalAssets - debt;
    const netLiquid   = cash + savings - debt;
    const cashOnHand  = cash + Math.max(savings - 15000, 0);
    return { spaceId, date, stocks, crypto, total, cash, savings, debt, netWorth, totalAssets, netLiquid, cashOnHand };
  });
}

function buildDebtHistory(spaceId: string) {
  return Array.from({ length: 90 }, (_, i) => {
    const date = D(89 - i);
    const t = i / 89;
    const debt    = Math.abs(Math.round(20200 - t * 3000 + (seededRand(i + 400) - 0.5) * 300));
    const cash    = Math.max(Math.round(1800  + Math.sin(i * 0.1) * 400 + (seededRand(i + 450) - 0.5) * 200), 0);
    const savings = Math.max(Math.round(5500  + t * 1000 + (seededRand(i + 460) - 0.5) * 100), 0);
    const stocks = 0; const crypto = 0; const total = 0;
    const totalAssets = cash + savings;
    const netWorth  = totalAssets - debt;
    const netLiquid = cash + savings - debt;
    const cashOnHand = 0;
    return { spaceId, date, stocks, crypto, total, cash, savings, debt, netWorth, totalAssets, netLiquid, cashOnHand };
  });
}

// ─── createFullAccount ────────────────────────────────────────────────────────
// Creates FinancialAccount + AccountConnection + SpaceAccountLink (HOME).
// v2.5-A Phase 4a: no longer creates legacy Account or WorkspaceAccountShare
// rows — FinancialAccount is canonical, SpaceAccountLink is the sole link path.
async function createFullAccount(opts: {
  spaceId:     string;
  userId:          string;
  plaidItemId?:    string;
  name:            string;
  type:            AccountType;
  institution:     string;
  institutionId?:  string;
  balance:         number;
  availableBalance?: number;
  creditLimit?:    number;
  debtSubtype?:    string;
  interestRate?:   number;
  minimumPayment?: number;
  currency?:       string;
  lastUpdated?:    Date;
  plaidAccountId?: string;
  walletAddress?:  string;
  walletChain?:    string;
  nativeBalance?:  number;
  syncStatus?:     string;
}) {
  const {
    spaceId, userId, plaidItemId,
    name, type, institution, institutionId,
    balance, availableBalance, creditLimit, debtSubtype, interestRate, minimumPayment,
    currency    = "USD",
    lastUpdated = new Date("2026-06-09T10:00:00Z"),
    plaidAccountId, walletAddress, walletChain, nativeBalance,
    syncStatus  = "synced",
  } = opts;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fa = await (prisma.financialAccount.create as any)({
    data: {
      ownerType: AccountOwnerType.USER, ownerUserId: userId,
      createdByUserId: userId,
      name, type, institution, institutionId: institutionId ?? null,
      balance, availableBalance, creditLimit, currency, lastUpdated,
      plaidAccountId: plaidAccountId ?? null,
      walletAddress: walletAddress ?? null, walletChain: walletChain ?? null,
      nativeBalance: nativeBalance ?? null, debtSubtype: debtSubtype ?? null,
      interestRate: interestRate ?? null, minimumPayment: minimumPayment ?? null,
      syncStatus,
    },
  });

  await prisma.accountConnection.create({
    data: {
      financialAccountId: fa.id, connectedByUserId: userId,
      plaidItemDbId: plaidItemId ?? null, syncStatus, isCanonical: true,
    },
  });

  // Every createFullAccount() call in this seed passes the creator's own
  // PERSONAL space as `spaceId`, so this is always the account's HOME link
  // by construction.
  await prisma.spaceAccountLink.create({
    data: {
      spaceId, financialAccountId: fa.id, addedByUserId: userId,
      visibilityLevel: VisibilityLevel.FULL, status: ShareStatus.ACTIVE,
      kind: SpaceAccountLinkKind.HOME,
    },
  });

  return fa as { id: string };
}

// ─── shareAccount — share an existing account into another space ──────────
async function shareAccount(
  spaceId: string,
  accountId:   string,
  userId:      string,
  level:       VisibilityLevel = VisibilityLevel.FULL,
) {
  // shareAccount() is only ever called to link an account into a space other
  // than its creator's PERSONAL space (that HOME link is created inside
  // createFullAccount() above), so this is always SHARED.
  await prisma.spaceAccountLink.create({
    data: {
      spaceId, financialAccountId: accountId, addedByUserId: userId,
      visibilityLevel: level, status: ShareStatus.ACTIVE,
      kind: SpaceAccountLinkKind.SHARED,
    },
  });
}

// ─── updateSectionConfig ──────────────────────────────────────────────────────
async function updateSectionConfig(spaceId: string, key: string, config: Record<string, unknown>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (prisma as any).spaceDashboardSection.updateMany({ where: { spaceId, key }, data: { config } });
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log("🌱  Seeding Fourth Meridian database…");
  console.log("   ⏳ Hashing passwords (bcrypt cost 12)…");

  const [janeHash, johnHash, alexHash, adminHash] = await Promise.all([
    bcrypt.hash(JANE_PASSWORD, 12),
    bcrypt.hash(JANE_PASSWORD, 12),
    bcrypt.hash(JANE_PASSWORD, 12),
    bcrypt.hash(ADMIN_PASSWORD, 12),
  ]);
  const janeDobEncrypted = encryptWithPurpose("1990-03-15", EncryptionPurpose.DATE_OF_BIRTH);
  const johnDobEncrypted = encryptWithPurpose("1988-07-22", EncryptionPurpose.DATE_OF_BIRTH);
  const alexDobEncrypted = encryptWithPurpose("1992-11-05", EncryptionPurpose.DATE_OF_BIRTH);

  // ── Wipe in reverse-dependency order ────────────────────────────────────────
  await prisma.goalCheckIn.deleteMany();
  await prisma.goalContribution.deleteMany();
  await prisma.spaceGoal.deleteMany();
  await prisma.duplicateAccountCandidate.deleteMany();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (prisma as any).spaceDashboardSection.deleteMany();
  await prisma.spaceAccountLink.deleteMany();
  // WorkspaceAccountShare retired (v2.5-A Phase 4c) — table dropped.
  await prisma.accountConnection.deleteMany();
  await prisma.financialAccount.deleteMany();
  await prisma.auditLog.deleteMany();
  await prisma.aiAdvice.deleteMany();
  await prisma.spaceSnapshot.deleteMany();
  await prisma.transaction.deleteMany();
  await prisma.holding.deleteMany();
  // Legacy Account is no longer seeded (v2.5-A Phase 4a). This wipe stays so a
  // re-seed clears legacy rows left by pre-rewrite seeds (making a re-seeded
  // dev DB pass the Phase 0 gates). Remove with the Phase 5 model drop.
  await prisma.account.deleteMany();
  await prisma.plaidItem.deleteMany();
  await prisma.aiAgent.deleteMany();
  await prisma.spaceInvite.deleteMany();
  await prisma.spaceMember.deleteMany();
  await prisma.space.deleteMany();
  await prisma.creditScore.deleteMany();
  await prisma.user.deleteMany();
  console.log("   ✓ Wiped all tables");

  // ── Users ───────────────────────────────────────────────────────────────────
  const jane = await prisma.user.create({
    data: {
      email: "jane@example.com", username: "janesmith",
      name: "Jane Smith", firstName: "Jane", lastName: "Smith",
      dateOfBirthEncrypted: janeDobEncrypted,
      employmentStatus: EmploymentStatus.EMPLOYED, useCase: UseCase.PERSONAL_TRACKING,
      passwordHash: janeHash, role: UserRole.USER,
      emailVerifiedAt: new Date(), // OPS-1 S2b — seed accounts start verified (login gate)
    },
  });
  const john = await prisma.user.create({
    data: {
      email: "john@example.com", username: "johndoe",
      name: "John Doe", firstName: "John", lastName: "Doe",
      dateOfBirthEncrypted: johnDobEncrypted,
      employmentStatus: EmploymentStatus.EMPLOYED, useCase: UseCase.PERSONAL_TRACKING,
      passwordHash: johnHash, role: UserRole.USER,
      emailVerifiedAt: new Date(), // OPS-1 S2b — seed accounts start verified (login gate)
    },
  });
  const alex = await prisma.user.create({
    data: {
      email: "alex@example.com", username: "alexchen",
      name: "Alex Chen", firstName: "Alex", lastName: "Chen",
      dateOfBirthEncrypted: alexDobEncrypted,
      employmentStatus: EmploymentStatus.EMPLOYED, useCase: UseCase.INVESTING,
      passwordHash: alexHash, role: UserRole.USER,
      emailVerifiedAt: new Date(), // OPS-1 S2b — seed accounts start verified (login gate)
    },
  });
  // ── SYSTEM_ADMIN — unchanged, dev-only account ────────────────────────────
  const admin = await prisma.user.create({
    data: {
      email: "sysadmin@example.com", username: "sysadmin",
      name: "Dev Sysadmin",
      passwordHash: adminHash, role: UserRole.SYSTEM_ADMIN,
      emailVerifiedAt: new Date(), // OPS-1 S2b — seed accounts start verified (login gate)
    },
  });
  console.log(`   ✓ Users: ${jane.email}, ${john.email}, ${alex.email}, ${admin.email}`);

  // ── Platform Spaces (PO1.0) ───────────────────────────────────────────────
  // Idempotent; access-derived (no SpaceMember rows). Seeded here so every dev
  // DB has the four platform Spaces; grants are issued from /admin/platform-access.
  await ensurePlatformSpaces(prisma);
  await ensurePlatformSections(prisma); // create-only backfill for sections added post-seed
  console.log("   ✓ Platform Spaces: 4 (Platform Ops, Security Ops, Growth & Revenue, Customer Success)");

  // ── Spaces (8) ──────────────────────────────────────────────────────────
  const janeSpace = await prisma.space.create({
    data: { name: "Jane's Space", type: "PERSONAL", category: "PERSONAL" },
  });
  const johnSpace = await prisma.space.create({
    data: { name: "John's Space", type: "PERSONAL", category: "PERSONAL" },
  });
  const householdSpace = await prisma.space.create({
    data: { name: "Smith-Doe Household", type: "SHARED", category: "HOUSEHOLD", isPublic: false, description: "Shared household finances for Jane & John" },
  });
  const debtSpace = await prisma.space.create({
    data: { name: "Debt Payoff Tracker", type: "SHARED", category: "DEBT_PAYOFF", isPublic: false, description: "Joint debt elimination plan" },
  });
  const japanSpace = await prisma.space.create({
    data: { name: "Japan Trip 2027", type: "SHARED", category: "TRIP", isPublic: false, description: "3-week Japan trip — saving $8,500 by March 2027" },
  });
  const investmentSpace = await prisma.space.create({
    data: { name: "Investment Club", type: "SHARED", category: "INVESTMENT", isPublic: false, description: "John & Jane portfolio tracking — Alex as advisor" },
  });
  const businessSpace = await prisma.space.create({
    data: { name: "JD Freelance LLC", type: "SHARED", category: "BUSINESS", isPublic: false, description: "John's freelance business finances — Alex bookkeeping" },
  });
  const propertySpace = await prisma.space.create({
    data: { name: "Austin Home", type: "SHARED", category: "PROPERTY", isPublic: false, description: "Primary residence — 3BR/2BA, purchased April 2020" },
  });
  console.log("   ✓ Spaces: 8");

  // ── Dashboard sections ───────────────────────────────────────────────────────
  async function seedSections(spaceId: string, category: string) {
    const template = getTemplateForCategory(category);
    if (!template) {
      throw new Error(`space-templates registry has no template for category ${category}`);
    }
    const { sectionsToCreate } = planTemplateApplication(template, new Set<string>());
    if (sectionsToCreate.length === 0) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (prisma as any).spaceDashboardSection.createMany({
      data: sectionsToCreate.map((s) => ({
        spaceId, key: s.key, label: s.label,
        tab: s.tab, enabled: s.enabled, order: s.order, config: s.config ?? null,
      })),
      skipDuplicates: true,
    });
  }

  await seedSections(janeSpace.id,       SpaceCategory.PERSONAL);
  await seedSections(johnSpace.id,       SpaceCategory.PERSONAL);
  await seedSections(householdSpace.id,  SpaceCategory.HOUSEHOLD);
  await seedSections(debtSpace.id,       SpaceCategory.DEBT_PAYOFF);
  await seedSections(japanSpace.id,      SpaceCategory.TRIP);
  await seedSections(investmentSpace.id, SpaceCategory.INVESTMENT);
  await seedSections(businessSpace.id,   SpaceCategory.BUSINESS);
  await seedSections(propertySpace.id,   SpaceCategory.PROPERTY);

  await updateSectionConfig(japanSpace.id, "trip_budget",  { targetAmount: 8500, amountSpent: 3240, currency: "USD" });
  await updateSectionConfig(japanSpace.id, "trip_savings", { targetAmount: 8500, targetDate: "2027-03-01" });

  // Add retirement_progress to investment space (not in INVESTMENT preset)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (prisma as any).spaceDashboardSection.create({
    data: {
      spaceId: investmentSpace.id, key: "retirement_progress",
      label: "Retirement Progress", tab: "OVERVIEW", enabled: true, order: 10,
      config: { targetAmount: 1500000, retirementAge: 65, currentAge: 38, expectedReturn: 7, annualContribution: 19500 },
    },
  });
  console.log("   ✓ SpaceDashboardSections + configs");

  // ── SpaceMembers ─────────────────────────────────────────────────────────
  await prisma.spaceMember.createMany({
    data: [
      { spaceId: janeSpace.id,       userId: jane.id, role: SpaceMemberRole.OWNER  },
      { spaceId: johnSpace.id,       userId: john.id, role: SpaceMemberRole.OWNER  },
      { spaceId: householdSpace.id,  userId: jane.id, role: SpaceMemberRole.OWNER  },
      { spaceId: householdSpace.id,  userId: john.id, role: SpaceMemberRole.MEMBER },
      { spaceId: debtSpace.id,       userId: john.id, role: SpaceMemberRole.OWNER  },
      { spaceId: debtSpace.id,       userId: jane.id, role: SpaceMemberRole.MEMBER },
      { spaceId: japanSpace.id,      userId: jane.id, role: SpaceMemberRole.OWNER  },
      { spaceId: japanSpace.id,      userId: john.id, role: SpaceMemberRole.MEMBER },
      { spaceId: investmentSpace.id, userId: john.id, role: SpaceMemberRole.OWNER  },
      { spaceId: investmentSpace.id, userId: jane.id, role: SpaceMemberRole.MEMBER },
      { spaceId: investmentSpace.id, userId: alex.id, role: SpaceMemberRole.VIEWER },
      { spaceId: businessSpace.id,   userId: john.id, role: SpaceMemberRole.OWNER  },
      { spaceId: businessSpace.id,   userId: alex.id, role: SpaceMemberRole.ADMIN  },
      { spaceId: propertySpace.id,   userId: john.id, role: SpaceMemberRole.OWNER  },
      { spaceId: propertySpace.id,   userId: jane.id, role: SpaceMemberRole.ADMIN  },
    ],
  });
  console.log("   ✓ SpaceMembers: 15");

  // ── AI Agents ────────────────────────────────────────────────────────────────
  const janeAgent = await prisma.aiAgent.create({ data: { spaceId: janeSpace.id, name: "Jane's Financial Agent" } });
  const johnAgent = await prisma.aiAgent.create({ data: { spaceId: johnSpace.id, name: "John's Financial Agent" } });
  // Every Space has exactly one AiAgent. The shared/category Spaces need one
  // too, or buildContext() throws "No AiAgent found" on the Daily Brief.
  await prisma.aiAgent.createMany({
    data: [
      { spaceId: householdSpace.id,  name: "Smith-Doe Household Agent" },
      { spaceId: debtSpace.id,       name: "Debt Payoff Tracker Agent" },
      { spaceId: japanSpace.id,      name: "Japan Trip 2027 Agent"     },
      { spaceId: investmentSpace.id, name: "Investment Club Agent"     },
      { spaceId: businessSpace.id,   name: "JD Freelance LLC Agent"    },
      { spaceId: propertySpace.id,   name: "Austin Home Agent"         },
    ],
  });
  console.log("   ✓ AiAgents: 8");

  // ── Credit Scores ────────────────────────────────────────────────────────────
  await prisma.creditScore.createMany({
    data: [
      { userId: jane.id, score: 720, source: "manual", recordedAt: new Date("2026-06-01T10:00:00Z") },
      { userId: john.id, score: 680, source: "manual", recordedAt: new Date("2026-06-01T10:00:00Z") },
      { userId: alex.id, score: 750, source: "manual", recordedAt: new Date("2026-06-01T10:00:00Z") },
    ],
  });
  console.log("   ✓ CreditScores: Jane 720, John 680, Alex 750");

  // ════════════════════════════════════════════════════════════════════════════
  // JANE SMITH — conservative, organized finances
  // ════════════════════════════════════════════════════════════════════════════

  const janePlaidItems = await prisma.plaidItem.createManyAndReturn({
    data: [
      { userId: jane.id, externalItemId: "demo_item_demobank",         institutionId: "demo_ins_001", institutionName: "Demo Bank",                encryptedToken: "[demo-placeholder-not-a-real-token]", status: PlaidItemStatus.ACTIVE },
      { userId: jane.id, externalItemId: "demo_item_examplecu",        institutionId: "demo_ins_002", institutionName: "Example Credit Union",     encryptedToken: "[demo-placeholder-not-a-real-token]", status: PlaidItemStatus.ACTIVE },
      { userId: jane.id, externalItemId: "demo_item_samplebrokerage",  institutionId: "demo_ins_003", institutionName: "Sample Brokerage",         encryptedToken: "[demo-placeholder-not-a-real-token]", status: PlaidItemStatus.ACTIVE },
      { userId: jane.id, externalItemId: "demo_item_fictionalcrypto",  institutionId: "demo_ins_004", institutionName: "Fictional Crypto Exchange", encryptedToken: "[demo-placeholder-not-a-real-token]", status: PlaidItemStatus.ACTIVE },
    ],
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const janeItemBy = Object.fromEntries(janePlaidItems.map((p: any) => [p.institutionName, p])) as Record<string, typeof janePlaidItems[0]>;

  // Jane — 9 accounts
  const jDemoChecking = await createFullAccount({
    spaceId: janeSpace.id, userId: jane.id,
    plaidItemId: janeItemBy["Demo Bank"].id, institutionId: "demo_ins_001",
    name: "Demo Bank Checking", type: AccountType.checking,
    institution: "Demo Bank", balance: 3450, availableBalance: 3450,
  });
  const jDemoHysa = await createFullAccount({
    spaceId: janeSpace.id, userId: jane.id,
    plaidItemId: janeItemBy["Demo Bank"].id, institutionId: "demo_ins_001",
    name: "Demo Bank High Yield Savings", type: AccountType.savings,
    institution: "Demo Bank", balance: 8500, availableBalance: 8500,
  });
  const jJapanSavings = await createFullAccount({
    spaceId: janeSpace.id, userId: jane.id,
    plaidItemId: janeItemBy["Demo Bank"].id, institutionId: "demo_ins_001",
    name: "Demo Bank Japan Trip Fund", type: AccountType.savings,
    institution: "Demo Bank", balance: 3240, availableBalance: 3240,
  });
  const _jCuChecking = await createFullAccount({
    spaceId: janeSpace.id, userId: jane.id,
    plaidItemId: janeItemBy["Example Credit Union"].id, institutionId: "demo_ins_002",
    name: "Example CU Checking", type: AccountType.checking,
    institution: "Example Credit Union", balance: 750, availableBalance: 750,
  });
  const jCreditCard = await createFullAccount({
    spaceId: janeSpace.id, userId: jane.id,
    plaidItemId: janeItemBy["Example Credit Union"].id, institutionId: "demo_ins_002",
    name: "Example CU Credit Card", type: AccountType.debt,
    institution: "Example Credit Union", balance: 3200, creditLimit: 10000,
    debtSubtype: "credit_card", interestRate: 19.99, minimumPayment: 85,
  });
  const jBrokerageIra = await createFullAccount({
    spaceId: janeSpace.id, userId: jane.id,
    plaidItemId: janeItemBy["Sample Brokerage"].id, institutionId: "demo_ins_003",
    name: "Sample Brokerage IRA", type: AccountType.investment,
    institution: "Sample Brokerage", balance: 9200,
  });
  const jBrokerageTaxable = await createFullAccount({
    spaceId: janeSpace.id, userId: jane.id,
    plaidItemId: janeItemBy["Sample Brokerage"].id, institutionId: "demo_ins_003",
    name: "Sample Brokerage Taxable", type: AccountType.investment,
    institution: "Sample Brokerage", balance: 3200,
  });
  const jCryptoExchange = await createFullAccount({
    spaceId: janeSpace.id, userId: jane.id,
    plaidItemId: janeItemBy["Fictional Crypto Exchange"].id, institutionId: "demo_ins_004",
    name: "Fictional Crypto Exchange", type: AccountType.crypto,
    institution: "Fictional Crypto Exchange", balance: 4850,
  });
  const jBtcWallet = await createFullAccount({
    spaceId: janeSpace.id, userId: jane.id,
    name: "Jane BTC Wallet", type: AccountType.crypto, institution: "Self-custodied",
    balance: 1950, walletAddress: "bc1demo000000000000000000000000000000000janeA",
    walletChain: "BTC", nativeBalance: 0.02,
    lastUpdated: new Date("2026-06-09T10:05:00Z"),
  });
  console.log("   ✓ Jane's accounts: 9");

  // Jane — cross-space shares
  // Household: checking FULL, HYSA BALANCE_ONLY, CC BALANCE_ONLY
  await shareAccount(householdSpace.id, jDemoChecking.id, jane.id, VisibilityLevel.FULL);
  await shareAccount(householdSpace.id, jDemoHysa.id,     jane.id, VisibilityLevel.BALANCE_ONLY);
  await shareAccount(householdSpace.id, jCreditCard.id,   jane.id, VisibilityLevel.BALANCE_ONLY);
  // Debt space: CC BALANCE_ONLY (John sees Jane's CC balance for household debt view)
  await shareAccount(debtSpace.id, jCreditCard.id, jane.id, VisibilityLevel.BALANCE_ONLY);
  // Japan Trip: Japan savings FULL, HYSA BALANCE_ONLY
  await shareAccount(japanSpace.id, jJapanSavings.id, jane.id, VisibilityLevel.FULL);
  await shareAccount(japanSpace.id, jDemoHysa.id,     jane.id, VisibilityLevel.BALANCE_ONLY);
  // Investment Club: IRA FULL, Taxable FULL, Crypto FULL
  await shareAccount(investmentSpace.id, jBrokerageIra.id,     jane.id, VisibilityLevel.FULL);
  await shareAccount(investmentSpace.id, jBrokerageTaxable.id, jane.id, VisibilityLevel.FULL);
  await shareAccount(investmentSpace.id, jCryptoExchange.id,   jane.id, VisibilityLevel.FULL);
  console.log("   ✓ Jane's cross-space shares: 9");

  // Jane — Holdings
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (prisma.holding as any).createMany({
    data: [
      { financialAccountId: jBrokerageIra.id,     symbol: "VOO",  name: "Vanguard S&P 500 ETF",     quantity: 18,    price: 490,   value: 8820,  change24h:  0.6 },
      { financialAccountId: jBrokerageIra.id,     symbol: "QQQ",  name: "Invesco QQQ Trust",         quantity:  1,    price: 380,   value:  380,  change24h:  1.1 },
      { financialAccountId: jBrokerageIra.id,     symbol: "CASH", name: "Uninvested Cash",           quantity:  0,    price:   1,   value:    0,  change24h:  0,   isCash: true },
      { financialAccountId: jBrokerageTaxable.id, symbol: "AAPL", name: "Apple Inc",                 quantity:  8,    price: 195,   value: 1560,  change24h:  0.4 },
      { financialAccountId: jBrokerageTaxable.id, symbol: "MSFT", name: "Microsoft Corp",            quantity:  3,    price: 420,   value: 1260,  change24h:  0.7 },
      { financialAccountId: jBrokerageTaxable.id, symbol: "VTI",  name: "Vanguard Total Market ETF", quantity:  2,    price: 245,   value:  490,  change24h:  0.5 },
      { financialAccountId: jBrokerageTaxable.id, symbol: "CASH", name: "Buying Power",              quantity: -110,  price:   1,   value: -110,  change24h:  0,   isCash: true },
      { financialAccountId: jCryptoExchange.id,   symbol: "BTC",  name: "Bitcoin",                   quantity: 0.025, price: 98000, value: 2450,  change24h:  1.2 },
      { financialAccountId: jCryptoExchange.id,   symbol: "ETH",  name: "Ethereum",                  quantity: 0.8,   price: 2750,  value: 2200,  change24h:  0.8 },
      { financialAccountId: jCryptoExchange.id,   symbol: "SOL",  name: "Solana",                    quantity: 3.0,   price: 66.67, value:  200,  change24h:  2.3 },
      { financialAccountId: jCryptoExchange.id,   symbol: "CASH", name: "USD Balance",               quantity: 0,     price:   1,   value:    0,  change24h:  0,   isCash: true },
      { financialAccountId: jBtcWallet.id,        symbol: "BTC",  name: "Bitcoin",                   quantity: 0.02,  price: 98000, value: 1960,  change24h:  1.2 },
    ],
  });
  console.log("   ✓ Holdings (Jane): 12");

  // Jane — transaction helpers
  const { Income, Transfer, Groceries, Dining, Shopping, Travel, Subscriptions, Utilities,
          Interest, Payment, Other, Buy, Sell, Dividend } = TransactionCategory;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type TxRow = any;
  const tx = (acct: { id: string }, n: number, merchant: string, cat: TransactionCategory, amount: number, pending = false, desc?: string): TxRow =>
    ({ financialAccountId: acct.id, date: D(n), merchant, category: cat, amount, pending, description: desc });
  const itx = (acct: { id: string }, n: number, ticker: string, cat: TransactionCategory, amount: number, desc: string): TxRow =>
    ({ financialAccountId: acct.id, date: D(n), merchant: ticker, category: cat, amount, pending: false, description: desc });

  await prisma.transaction.createMany({ data: [
    // Jane Checking — Payroll (bi-weekly ×9)
    tx(jDemoChecking,  2, "Payroll Direct Deposit", Income,  3800),
    tx(jDemoChecking, 16, "Payroll Direct Deposit", Income,  3800),
    tx(jDemoChecking, 30, "Payroll Direct Deposit", Income,  3800),
    tx(jDemoChecking, 44, "Payroll Direct Deposit", Income,  3800),
    tx(jDemoChecking, 58, "Payroll Direct Deposit", Income,  3800),
    tx(jDemoChecking, 72, "Payroll Direct Deposit", Income,  3800),
    tx(jDemoChecking, 86, "Payroll Direct Deposit", Income,  3800),
    tx(jDemoChecking,100, "Payroll Direct Deposit", Income,  3800),
    tx(jDemoChecking,114, "Payroll Direct Deposit", Income,  3800),
    // Groceries (every ~8 days ×14)
    tx(jDemoChecking,  1, "Fresh Market",     Groceries,  -92.40, true),
    tx(jDemoChecking,  9, "Whole Foods Local",Groceries,  -67.80),
    tx(jDemoChecking, 17, "Fresh Market",     Groceries,  -84.15),
    tx(jDemoChecking, 25, "Bulk Warehouse",   Groceries, -118.60),
    tx(jDemoChecking, 33, "Fresh Market",     Groceries,  -71.20),
    tx(jDemoChecking, 41, "Whole Foods Local",Groceries,  -58.40),
    tx(jDemoChecking, 49, "Fresh Market",     Groceries,  -95.80),
    tx(jDemoChecking, 57, "Bulk Warehouse",   Groceries, -126.30),
    tx(jDemoChecking, 65, "Fresh Market",     Groceries,  -78.60),
    tx(jDemoChecking, 73, "Whole Foods Local",Groceries,  -63.20),
    tx(jDemoChecking, 81, "Fresh Market",     Groceries,  -89.40),
    tx(jDemoChecking, 89, "Bulk Warehouse",   Groceries, -112.70),
    tx(jDemoChecking, 97, "Fresh Market",     Groceries,  -74.50),
    tx(jDemoChecking,105, "Whole Foods Local",Groceries,  -59.30),
    // Utilities — electric ×4
    tx(jDemoChecking,  5, "Metro Electric",   Utilities,  -94.50),
    tx(jDemoChecking, 35, "Metro Electric",   Utilities,  -88.20),
    tx(jDemoChecking, 65, "Metro Electric",   Utilities, -101.40),
    tx(jDemoChecking, 95, "Metro Electric",   Utilities,  -97.80),
    // Utilities — internet ×4
    tx(jDemoChecking,  6, "FiberNet ISP",     Utilities,  -59.99),
    tx(jDemoChecking, 36, "FiberNet ISP",     Utilities,  -59.99),
    tx(jDemoChecking, 66, "FiberNet ISP",     Utilities,  -59.99),
    tx(jDemoChecking, 96, "FiberNet ISP",     Utilities,  -59.99),
    // Utilities — phone ×4
    tx(jDemoChecking,  7, "TelecomPlus",      Utilities,  -65.00),
    tx(jDemoChecking, 37, "TelecomPlus",      Utilities,  -65.00),
    tx(jDemoChecking, 67, "TelecomPlus",      Utilities,  -65.00),
    tx(jDemoChecking, 97, "TelecomPlus",      Utilities,  -65.00),
    // Subscriptions ×3 services ×4 months
    tx(jDemoChecking,  1, "StreamFlix",       Subscriptions, -15.99),
    tx(jDemoChecking, 31, "StreamFlix",       Subscriptions, -15.99),
    tx(jDemoChecking, 61, "StreamFlix",       Subscriptions, -15.99),
    tx(jDemoChecking, 91, "StreamFlix",       Subscriptions, -15.99),
    tx(jDemoChecking,  1, "MusicStream",      Subscriptions,  -9.99),
    tx(jDemoChecking, 31, "MusicStream",      Subscriptions,  -9.99),
    tx(jDemoChecking, 61, "MusicStream",      Subscriptions,  -9.99),
    tx(jDemoChecking, 91, "MusicStream",      Subscriptions,  -9.99),
    tx(jDemoChecking,  1, "Gym Membership",   Subscriptions, -32.00),
    tx(jDemoChecking, 31, "Gym Membership",   Subscriptions, -32.00),
    tx(jDemoChecking, 61, "Gym Membership",   Subscriptions, -32.00),
    tx(jDemoChecking, 91, "Gym Membership",   Subscriptions, -32.00),
    // Transfers to HYSA ×5
    tx(jDemoChecking,  3, "Transfer to HYSA", Transfer, -400),
    tx(jDemoChecking, 33, "Transfer to HYSA", Transfer, -400),
    tx(jDemoChecking, 63, "Transfer to HYSA", Transfer, -400),
    tx(jDemoChecking, 93, "Transfer to HYSA", Transfer, -400),
    tx(jDemoChecking,113, "Transfer to HYSA", Transfer, -400),
    // Transfers to Japan fund ×4
    tx(jDemoChecking, 15, "Transfer to Japan Fund", Transfer, -500),
    tx(jDemoChecking, 45, "Transfer to Japan Fund", Transfer, -500),
    tx(jDemoChecking, 75, "Transfer to Japan Fund", Transfer, -500),
    tx(jDemoChecking,105, "Transfer to Japan Fund", Transfer, -500),
    // Gas ×5
    tx(jDemoChecking, 10, "QuickFuel Gas",    Other,  -52.40),
    tx(jDemoChecking, 28, "QuickFuel Gas",    Other,  -48.60),
    tx(jDemoChecking, 56, "QuickFuel Gas",    Other,  -61.20),
    tx(jDemoChecking, 84, "QuickFuel Gas",    Other,  -54.80),
    tx(jDemoChecking,108, "QuickFuel Gas",    Other,  -50.10),
    // Pharmacy ×3
    tx(jDemoChecking, 18, "City Pharmacy",    Shopping, -24.60),
    tx(jDemoChecking, 55, "City Pharmacy",    Shopping, -38.90),
    tx(jDemoChecking, 82, "City Pharmacy",    Shopping, -19.40),
  ]});

  await prisma.transaction.createMany({ data: [
    // Jane HYSA — interest ×4
    tx(jDemoHysa, 10, "Interest Credit", Interest, 34.50, false, "HYSA Interest — May 2026 (4.35% APY)"),
    tx(jDemoHysa, 40, "Interest Credit", Interest, 33.80, false, "HYSA Interest — Apr 2026"),
    tx(jDemoHysa, 70, "Interest Credit", Interest, 31.20, false, "HYSA Interest — Mar 2026"),
    tx(jDemoHysa,100, "Interest Credit", Interest, 28.60, false, "HYSA Interest — Feb 2026"),
    // HYSA — transfers in ×5
    tx(jDemoHysa,  3, "Transfer from Checking", Transfer, 400),
    tx(jDemoHysa, 33, "Transfer from Checking", Transfer, 400),
    tx(jDemoHysa, 63, "Transfer from Checking", Transfer, 400),
    tx(jDemoHysa, 93, "Transfer from Checking", Transfer, 400),
    tx(jDemoHysa,113, "Transfer from Checking", Transfer, 400),
    // HYSA — transfers to Japan ×3
    tx(jDemoHysa, 45, "Transfer to Japan Fund", Transfer, -300),
    tx(jDemoHysa, 75, "Transfer to Japan Fund", Transfer, -300),
    tx(jDemoHysa,105, "Transfer to Japan Fund", Transfer, -300),
    // Japan savings — transfers in ×4+3
    tx(jJapanSavings, 15, "Transfer from Checking", Transfer, 500),
    tx(jJapanSavings, 45, "Transfer from Checking", Transfer, 500),
    tx(jJapanSavings, 75, "Transfer from Checking", Transfer, 500),
    tx(jJapanSavings,105, "Transfer from Checking", Transfer, 500),
    tx(jJapanSavings, 45, "Transfer from HYSA",     Transfer, 300),
    tx(jJapanSavings, 75, "Transfer from HYSA",     Transfer, 300),
    tx(jJapanSavings,105, "Transfer from HYSA",     Transfer, 300),
    tx(jJapanSavings, 30, "Interest Credit",  Interest,  8.40, false, "Japan Trip Fund Interest — Apr 2026"),
  ]});

  await prisma.transaction.createMany({ data: [
    // Jane Credit Card — Dining ×15
    tx(jCreditCard,  2, "Sakura Sushi",         Dining,  -68.40),
    tx(jCreditCard,  6, "Corner Coffee",         Dining,   -8.75),
    tx(jCreditCard, 10, "Thai Garden",           Dining,  -42.50),
    tx(jCreditCard, 14, "Corner Coffee",         Dining,   -9.25),
    tx(jCreditCard, 18, "The Pasta House",       Dining,  -55.80),
    tx(jCreditCard, 22, "Corner Coffee",         Dining,   -8.50),
    tx(jCreditCard, 27, "Brunch Spot",           Dining,  -38.60),
    tx(jCreditCard, 32, "Mexican Cantina",       Dining,  -47.20),
    tx(jCreditCard, 38, "Corner Coffee",         Dining,   -9.00),
    tx(jCreditCard, 44, "Italian Bistro",        Dining,  -82.40),
    tx(jCreditCard, 50, "Thai Garden",           Dining,  -38.90),
    tx(jCreditCard, 56, "Corner Coffee",         Dining,   -7.80),
    tx(jCreditCard, 62, "Tapas Bar",             Dining,  -72.30),
    tx(jCreditCard, 68, "Brunch Spot",           Dining,  -41.50),
    tx(jCreditCard, 74, "Corner Coffee",         Dining,   -8.90),
    // Shopping ×10
    tx(jCreditCard,  4, "FashionNova Online",   Shopping,  -89.99),
    tx(jCreditCard, 12, "Target",               Shopping,  -74.30),
    tx(jCreditCard, 20, "Amazon Marketplace",   Shopping,  -54.99),
    tx(jCreditCard, 29, "HomeGoods Store",      Shopping, -138.40),
    tx(jCreditCard, 40, "Amazon Marketplace",   Shopping,  -32.50),
    tx(jCreditCard, 48, "Sephora",              Shopping,  -96.80),
    tx(jCreditCard, 59, "Amazon Marketplace",   Shopping,  -67.40),
    tx(jCreditCard, 70, "ASOS Online",          Shopping, -119.00),
    tx(jCreditCard, 80, "Target",               Shopping,  -58.70),
    tx(jCreditCard, 90, "Sephora",              Shopping,  -74.30),
    // Travel ×3
    tx(jCreditCard, 25, "Japan Airlines",       Travel,  -820.00, false, "RT flight deposit — Tokyo"),
    tx(jCreditCard, 60, "Hotel Booking",        Travel,  -385.00),
    tx(jCreditCard, 88, "Airbnb",               Travel,  -290.00),
    // Beauty ×4
    tx(jCreditCard, 15, "Ulta Beauty",          Shopping,  -62.40),
    tx(jCreditCard, 45, "Hair Salon",           Other,     -85.00),
    tx(jCreditCard, 76, "Ulta Beauty",          Shopping,  -48.20),
    tx(jCreditCard,109, "Hair Salon",           Other,     -90.00),
    // Entertainment ×4
    tx(jCreditCard,  8, "Cinema Downtown",      Other,  -32.00),
    tx(jCreditCard, 35, "Event Tickets Online", Other, -140.00),
    tx(jCreditCard, 66, "Cinema Downtown",      Other,  -28.50),
    tx(jCreditCard, 95, "Yoga Studio",          Other,  -25.00),
    // Subscriptions on CC ×3 months
    tx(jCreditCard,  1, "Adobe Creative Cloud", Subscriptions, -54.99),
    tx(jCreditCard, 31, "Adobe Creative Cloud", Subscriptions, -54.99),
    tx(jCreditCard, 61, "Adobe Creative Cloud", Subscriptions, -54.99),
    // CC payments ×3
    tx(jCreditCard, 28, "CC Payment", Payment, -800),
    tx(jCreditCard, 60, "CC Payment", Payment, -600),
    tx(jCreditCard, 90, "CC Payment", Payment, -700),
    // Groceries on CC ×3
    tx(jCreditCard, 11, "Whole Foods Local",    Groceries,  -88.40, true),
    tx(jCreditCard, 55, "Trader Joe's",         Groceries,  -67.20),
    tx(jCreditCard, 83, "Whole Foods Local",    Groceries,  -91.60),
  ]});

  await prisma.transaction.createMany({ data: [
    // Jane IRA ×8
    itx(jBrokerageIra,  5, "VOO",          Buy,       -1960, "Buy 4 shares VOO @ $490"),
    itx(jBrokerageIra, 35, "VOO",          Buy,       -1470, "Buy 3 shares VOO @ $490"),
    itx(jBrokerageIra, 65, "QQQ",          Buy,        -380, "Buy 1 share QQQ @ $380"),
    itx(jBrokerageIra, 95, "VOO",          Buy,        -980, "Buy 2 shares VOO @ $490"),
    itx(jBrokerageIra, 30, "VOO",          Dividend,    88.20, "VOO Quarterly Dividend"),
    itx(jBrokerageIra, 60, "QQQ",          Dividend,    18.40, "QQQ Quarterly Dividend"),
    itx(jBrokerageIra, 30, "CONTRIBUTION", Income,     583,   "IRA Monthly Contribution"),
    itx(jBrokerageIra, 60, "CONTRIBUTION", Income,     583,   "IRA Monthly Contribution"),
    // Jane Taxable ×6
    itx(jBrokerageTaxable, 10, "AAPL", Buy,       -780,  "Buy 4 shares AAPL @ $195"),
    itx(jBrokerageTaxable, 40, "MSFT", Buy,      -1260,  "Buy 3 shares MSFT @ $420"),
    itx(jBrokerageTaxable, 70, "VTI",  Buy,       -490,  "Buy 2 shares VTI @ $245"),
    itx(jBrokerageTaxable,100, "AAPL", Buy,       -780,  "Buy 4 shares AAPL @ $195"),
    itx(jBrokerageTaxable, 30, "AAPL", Dividend,   22.00, "AAPL Quarterly Dividend"),
    itx(jBrokerageTaxable, 60, "MSFT", Dividend,   33.60, "MSFT Quarterly Dividend"),
    // Jane Crypto ×6
    itx(jCryptoExchange,  5, "BTC", Buy,  -2450, "Buy 0.025 BTC @ $98,000"),
    itx(jCryptoExchange, 25, "ETH", Buy,  -2200, "Buy 0.8 ETH @ $2,750"),
    itx(jCryptoExchange, 50, "SOL", Buy,   -200, "Buy 3 SOL @ $66.67"),
    itx(jCryptoExchange, 75, "BTC", Sell,  1200, "Sell 0.013 BTC — partial exit"),
    itx(jCryptoExchange, 90, "ETH", Buy,  -1100, "Buy 0.4 ETH @ $2,750"),
    itx(jCryptoExchange,110, "BTC", Buy,  -1960, "Buy 0.02 BTC @ $98,000"),
    // Jane BTC Wallet ×2
    itx(jBtcWallet, 40, "BTC", Buy,   -1960, "Buy 0.02 BTC → self-custody transfer"),
    itx(jBtcWallet,100, "BTC", Sell,    490, "Sell 0.005 BTC — partial profit"),
  ]});
  console.log("   ✓ Jane transactions: ~150");

  // Jane — AI Advice
  await prisma.aiAdvice.create({
    data: {
      spaceId: janeSpace.id, agentId: janeAgent.id,
      summary: "Strong savings rate and low debt — focus on IRA contributions and CC payoff.",
      adviceText: `**Market Context (June 2026):** BTC ~$98,000. S&P 500 steady. HYSA at 4.35% APY.

**Your Position:**
- Cash: $3,450 + $750 = **$4,200** (~1 month cushion)
- HYSA: **$8,500** (~2 months expenses)
- Japan Fund: **$3,240** (target $8,500 — on track)
- Investments: **$12,400** — well diversified
- Crypto: **$6,800** (~28% of investable assets)
- Debt: **$3,200** credit card (19.99% APR)
- Net worth: ~**$28,700**

**Priority Actions:**
1. Pay down CC in 3–4 months (19.99% APR)
2. Max IRA contribution ($7,000/yr)
3. Hit $12,000 emergency fund milestone
4. Japan Trip on track — keep $500/mo transfers

**Risk Level: Low-Medium** | **Action Ready: Yes**`,
      riskLevel: "low", actionReady: true, generatedAt: new Date("2026-06-09T09:00:00Z"),
    },
  });

  // Jane — Snapshots
  await prisma.spaceSnapshot.createMany({ data: buildHistory(janeSpace.id) });
  console.log("   ✓ SpaceSnapshots (Jane): 365");

  // ════════════════════════════════════════════════════════════════════════════
  // JOHN DOE — medium risk, freelance side income, higher debt
  // ════════════════════════════════════════════════════════════════════════════

  const johnPlaidItems = await prisma.plaidItem.createManyAndReturn({
    data: [
      { userId: john.id, externalItemId: "demo_item_beaconbank",     institutionId: "demo_ins_005", institutionName: "Beacon Bank",           encryptedToken: "[demo-placeholder-not-a-real-token]", status: PlaidItemStatus.ACTIVE },
      { userId: john.id, externalItemId: "demo_item_alphabrokerage", institutionId: "demo_ins_006", institutionName: "Alpha Brokerage",       encryptedToken: "[demo-placeholder-not-a-real-token]", status: PlaidItemStatus.ACTIVE },
      { userId: john.id, externalItemId: "demo_item_alphacrypto",    institutionId: "demo_ins_007", institutionName: "Alpha Crypto Exchange", encryptedToken: "[demo-placeholder-not-a-real-token]", status: PlaidItemStatus.ACTIVE },
      { userId: john.id, externalItemId: "demo_item_summitbusiness", institutionId: "demo_ins_008", institutionName: "Summit Business Bank",  encryptedToken: "[demo-placeholder-not-a-real-token]", status: PlaidItemStatus.ACTIVE },
      { userId: john.id, externalItemId: "demo_item_manual_john",    institutionId: "manual_entry", institutionName: "Manual Entry",           encryptedToken: "[demo-placeholder-not-a-real-token]", status: PlaidItemStatus.ACTIVE },
    ],
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const johnItemBy = Object.fromEntries(johnPlaidItems.map((p: any) => [p.institutionName, p])) as Record<string, typeof johnPlaidItems[0]>;

  // John — 12 accounts
  const jnChecking = await createFullAccount({
    spaceId: johnSpace.id, userId: john.id,
    plaidItemId: johnItemBy["Beacon Bank"].id, institutionId: "demo_ins_005",
    name: "Beacon Bank Checking", type: AccountType.checking,
    institution: "Beacon Bank", balance: 2100, availableBalance: 2100,
  });
  const jnSavings = await createFullAccount({
    spaceId: johnSpace.id, userId: john.id,
    plaidItemId: johnItemBy["Beacon Bank"].id, institutionId: "demo_ins_005",
    name: "Beacon Bank Savings", type: AccountType.savings,
    institution: "Beacon Bank", balance: 5500, availableBalance: 5500,
  });
  const jnCreditCard = await createFullAccount({
    spaceId: johnSpace.id, userId: john.id,
    plaidItemId: johnItemBy["Beacon Bank"].id, institutionId: "demo_ins_005",
    name: "Beacon Credit Card", type: AccountType.debt,
    institution: "Beacon Bank", balance: 5800, creditLimit: 15000,
    debtSubtype: "credit_card", interestRate: 22.99, minimumPayment: 135,
  });
  const jnAutoLoan = await createFullAccount({
    spaceId: johnSpace.id, userId: john.id,
    plaidItemId: johnItemBy["Beacon Bank"].id, institutionId: "demo_ins_005",
    name: "Beacon Auto Loan", type: AccountType.debt,
    institution: "Beacon Bank", balance: 11200,
    debtSubtype: "auto_loan", interestRate: 6.49, minimumPayment: 287,
  });
  const jnMortgage = await createFullAccount({
    spaceId: johnSpace.id, userId: john.id,
    plaidItemId: johnItemBy["Beacon Bank"].id, institutionId: "demo_ins_005",
    name: "Beacon Mortgage", type: AccountType.debt,
    institution: "Beacon Bank", balance: 285000,
    debtSubtype: "mortgage", interestRate: 3.875, minimumPayment: 1480,
  });
  const jnRothIra = await createFullAccount({
    spaceId: johnSpace.id, userId: john.id,
    plaidItemId: johnItemBy["Alpha Brokerage"].id, institutionId: "demo_ins_006",
    name: "Alpha Brokerage Roth IRA", type: AccountType.investment,
    institution: "Alpha Brokerage", balance: 28500,
  });
  const jn401k = await createFullAccount({
    spaceId: johnSpace.id, userId: john.id,
    plaidItemId: johnItemBy["Alpha Brokerage"].id, institutionId: "demo_ins_006",
    name: "Alpha Brokerage 401k", type: AccountType.investment,
    institution: "Alpha Brokerage", balance: 18200,
  });
  const jnBrokerage = await createFullAccount({
    spaceId: johnSpace.id, userId: john.id,
    plaidItemId: johnItemBy["Alpha Brokerage"].id, institutionId: "demo_ins_006",
    name: "Alpha Brokerage Taxable", type: AccountType.investment,
    institution: "Alpha Brokerage", balance: 12800,
  });
  const jnCryptoExchange = await createFullAccount({
    spaceId: johnSpace.id, userId: john.id,
    plaidItemId: johnItemBy["Alpha Crypto Exchange"].id, institutionId: "demo_ins_007",
    name: "Alpha Crypto Exchange", type: AccountType.crypto,
    institution: "Alpha Crypto Exchange", balance: 7400,
  });
  const jnBtcWallet = await createFullAccount({
    spaceId: johnSpace.id, userId: john.id,
    name: "John BTC Wallet", type: AccountType.crypto, institution: "Self-custodied",
    balance: 3724, walletAddress: "bc1demo000000000000000000000000000000000johnB",
    walletChain: "BTC", nativeBalance: 0.038,
    lastUpdated: new Date("2026-06-09T10:10:00Z"),
  });
  const jnBizChecking = await createFullAccount({
    spaceId: johnSpace.id, userId: john.id,
    plaidItemId: johnItemBy["Summit Business Bank"].id, institutionId: "demo_ins_008",
    name: "Summit Business Checking", type: AccountType.checking,
    institution: "Summit Business Bank", balance: 8400, availableBalance: 8400,
  });
  const jnBizCard = await createFullAccount({
    spaceId: johnSpace.id, userId: john.id,
    plaidItemId: johnItemBy["Summit Business Bank"].id, institutionId: "demo_ins_008",
    name: "Summit Business Credit Card", type: AccountType.debt,
    institution: "Summit Business Bank", balance: 2100, creditLimit: 20000,
    debtSubtype: "credit_card", interestRate: 18.99, minimumPayment: 55,
  });
  // Manual asset accounts (AccountType.other as temporary asset bucket until AccountType.asset lands)
  // These are user-entered balances — syncStatus "manual" distinguishes them from Plaid-connected accounts.
  // They must NOT appear in debt payoff, cash-flow, or minimum-payment queries.
  // TODO: when AccountType.asset is added to schema, run:
  //   UPDATE "FinancialAccount" SET type = 'asset' WHERE type = 'other' AND "syncStatus" = 'manual'
  const jnHome = await createFullAccount({
    spaceId: johnSpace.id, userId: john.id,
    plaidItemId: johnItemBy["Manual Entry"].id, institutionId: "manual_entry",
    name: "Austin Home (Est. Value)", type: AccountType.other,
    institution: "Manual Entry", balance: 485000, syncStatus: "manual",
  });
  const _jnVehicle = await createFullAccount({
    spaceId: johnSpace.id, userId: john.id,
    plaidItemId: johnItemBy["Manual Entry"].id, institutionId: "manual_entry",
    name: "2022 Honda CR-V (Est. Value)", type: AccountType.other,
    institution: "Manual Entry", balance: 22000, syncStatus: "manual",
  });
  const jnEquipment = await createFullAccount({
    spaceId: johnSpace.id, userId: john.id,
    plaidItemId: johnItemBy["Manual Entry"].id, institutionId: "manual_entry",
    name: "Freelance Business Equipment", type: AccountType.other,
    institution: "Manual Entry", balance: 3500, syncStatus: "manual",
  });
  console.log("   ✓ John's accounts: 12 financial + 3 manual asset (total 15)");

  // John — cross-space shares
  // Household: checking FULL, savings BALANCE_ONLY, CC BALANCE_ONLY, mortgage FULL
  await shareAccount(householdSpace.id, jnChecking.id,    john.id, VisibilityLevel.FULL);
  await shareAccount(householdSpace.id, jnSavings.id,     john.id, VisibilityLevel.BALANCE_ONLY);
  await shareAccount(householdSpace.id, jnCreditCard.id,  john.id, VisibilityLevel.BALANCE_ONLY);
  await shareAccount(householdSpace.id, jnMortgage.id,    john.id, VisibilityLevel.FULL);
  // Debt space: CC FULL, auto loan FULL
  await shareAccount(debtSpace.id, jnCreditCard.id, john.id, VisibilityLevel.FULL);
  await shareAccount(debtSpace.id, jnAutoLoan.id,   john.id, VisibilityLevel.FULL);
  // Japan Trip: John's checking BALANCE_ONLY (for trip budget awareness)
  await shareAccount(japanSpace.id, jnChecking.id, john.id, VisibilityLevel.BALANCE_ONLY);
  // Investment Club: Roth IRA FULL, 401k FULL, Taxable FULL, Crypto FULL, BTC wallet FULL
  await shareAccount(investmentSpace.id, jnRothIra.id,       john.id, VisibilityLevel.FULL);
  await shareAccount(investmentSpace.id, jn401k.id,          john.id, VisibilityLevel.FULL);
  await shareAccount(investmentSpace.id, jnBrokerage.id,     john.id, VisibilityLevel.FULL);
  await shareAccount(investmentSpace.id, jnCryptoExchange.id,john.id, VisibilityLevel.FULL);
  await shareAccount(investmentSpace.id, jnBtcWallet.id,     john.id, VisibilityLevel.FULL);
  // Business: biz checking FULL, biz CC FULL
  await shareAccount(businessSpace.id, jnBizChecking.id, john.id, VisibilityLevel.FULL);
  await shareAccount(businessSpace.id, jnBizCard.id,     john.id, VisibilityLevel.FULL);
  // Property: mortgage FULL, home asset FULL, checking BALANCE_ONLY
  await shareAccount(propertySpace.id, jnMortgage.id,  john.id, VisibilityLevel.FULL);
  await shareAccount(propertySpace.id, jnHome.id,      john.id, VisibilityLevel.FULL);
  await shareAccount(propertySpace.id, jnChecking.id,  john.id, VisibilityLevel.BALANCE_ONLY);
  // Household: home asset FULL (for household net worth)
  await shareAccount(householdSpace.id, jnHome.id,     john.id, VisibilityLevel.FULL);
  // Business: equipment FULL
  await shareAccount(businessSpace.id, jnEquipment.id, john.id, VisibilityLevel.FULL);
  console.log("   ✓ John's cross-space shares: 19 (incl. 3 manual asset shares)");

  // Config-driven section overrides that depend on John's manual asset account IDs.
  // Placed here (after jnHome / jnEquipment are created) to avoid a temporal dead zone error.
  // accountId pins the section to the correct FinancialAccount so the adapter skips name heuristics.
  await updateSectionConfig(propertySpace.id, "property_value", {
    accountId:       jnHome.id,
    assetKind:       "real_estate",
    purchasePrice:   320000,
    purchaseDate:    "2020-04-15",
    estimatedSource: "Manual",
    estimatedAt:     "2026-06-14",
    notes:           "3BR/2BA primary residence — Austin, TX",
  });
  await updateSectionConfig(businessSpace.id, "equipment_value", {
    accountId:       jnEquipment.id,
    purchasePrice:   4200,
    purchaseDate:    "2023-09-01",
    estimatedSource: "Manual",
    notes:           "MacBook Pro M3 + monitors + peripherals",
  });

  // John — Holdings
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (prisma.holding as any).createMany({
    data: [
      // Roth IRA: VOO, SCHD, BND, VXUS, VNQ
      { financialAccountId: jnRothIra.id,        symbol: "VOO",  name: "Vanguard S&P 500 ETF",          quantity: 35,    price: 490,   value: 17150, change24h:  0.6 },
      { financialAccountId: jnRothIra.id,        symbol: "SCHD", name: "Schwab US Dividend ETF",         quantity: 60,    price: 78,    value:  4680, change24h:  0.3 },
      { financialAccountId: jnRothIra.id,        symbol: "BND",  name: "Vanguard Total Bond ETF",        quantity: 30,    price: 74,    value:  2220, change24h: -0.1 },
      { financialAccountId: jnRothIra.id,        symbol: "VXUS", name: "Vanguard Total Intl Stock ETF",  quantity: 25,    price: 65,    value:  1625, change24h:  0.4 },
      { financialAccountId: jnRothIra.id,        symbol: "VNQ",  name: "Vanguard Real Estate ETF",       quantity: 20,    price: 95,    value:  1900, change24h:  0.2 },
      { financialAccountId: jnRothIra.id,        symbol: "CASH", name: "Uninvested Cash",                quantity: 925,   price:   1,   value:   925, change24h:  0,   isCash: true },
      // 401k: NVDA, TSLA, VOO
      { financialAccountId: jn401k.id,           symbol: "NVDA", name: "NVIDIA Corp",                    quantity: 5,     price: 1100,  value:  5500, change24h:  2.1 },
      { financialAccountId: jn401k.id,           symbol: "TSLA", name: "Tesla Inc",                      quantity: 10,    price:  280,  value:  2800, change24h: -0.9 },
      { financialAccountId: jn401k.id,           symbol: "VOO",  name: "Vanguard S&P 500 ETF",           quantity: 20,    price:  490,  value:  9800, change24h:  0.6 },
      { financialAccountId: jn401k.id,           symbol: "CASH", name: "Uninvested Cash",                quantity: 100,   price:    1,  value:   100, change24h:  0,   isCash: true },
      // Taxable: QQQ, AAPL, MSFT
      { financialAccountId: jnBrokerage.id,      symbol: "QQQ",  name: "Invesco QQQ Trust",              quantity: 15,    price: 380,   value:  5700, change24h:  1.1 },
      { financialAccountId: jnBrokerage.id,      symbol: "AAPL", name: "Apple Inc",                      quantity: 20,    price: 195,   value:  3900, change24h:  0.4 },
      { financialAccountId: jnBrokerage.id,      symbol: "MSFT", name: "Microsoft Corp",                 quantity:  5,    price: 420,   value:  2100, change24h:  0.7 },
      { financialAccountId: jnBrokerage.id,      symbol: "CASH", name: "Buying Power",                   quantity: 1100,  price:   1,   value:  1100, change24h:  0,   isCash: true },
      // Crypto exchange: BTC, ETH, DOGE
      { financialAccountId: jnCryptoExchange.id, symbol: "BTC",  name: "Bitcoin",                        quantity: 0.04,  price: 98000, value:  3920, change24h:  1.2 },
      { financialAccountId: jnCryptoExchange.id, symbol: "ETH",  name: "Ethereum",                       quantity: 1.2,   price:  2750, value:  3300, change24h:  0.8 },
      { financialAccountId: jnCryptoExchange.id, symbol: "DOGE", name: "Dogecoin",                       quantity: 1000,  price:  0.18, value:   180, change24h:  5.4 },
      { financialAccountId: jnCryptoExchange.id, symbol: "CASH", name: "USD Balance",                    quantity: 0,     price:    1,  value:     0, change24h:  0,   isCash: true },
      // BTC wallet
      { financialAccountId: jnBtcWallet.id,      symbol: "BTC",  name: "Bitcoin",                        quantity: 0.038, price: 98000, value:  3724, change24h:  1.2 },
    ],
  });
  console.log("   ✓ Holdings (John): 19");

  await prisma.transaction.createMany({ data: [
    // John Checking — Payroll ×9
    tx(jnChecking,  3, "Apex Corp Payroll",   Income,  4200),
    tx(jnChecking, 17, "Apex Corp Payroll",   Income,  4200),
    tx(jnChecking, 31, "Apex Corp Payroll",   Income,  4200),
    tx(jnChecking, 45, "Apex Corp Payroll",   Income,  4200),
    tx(jnChecking, 59, "Apex Corp Payroll",   Income,  4200),
    tx(jnChecking, 73, "Apex Corp Payroll",   Income,  4200),
    tx(jnChecking, 87, "Apex Corp Payroll",   Income,  4200),
    tx(jnChecking,101, "Apex Corp Payroll",   Income,  4200),
    tx(jnChecking,115, "Apex Corp Payroll",   Income,  4200),
    // Groceries ×12
    tx(jnChecking,  2, "Neighborhood Market", Groceries,  -88.50, true),
    tx(jnChecking, 10, "Wholesale Club",      Groceries, -134.20),
    tx(jnChecking, 18, "Neighborhood Market", Groceries,  -72.10),
    tx(jnChecking, 26, "Neighborhood Market", Groceries,  -91.40),
    tx(jnChecking, 34, "Wholesale Club",      Groceries, -118.60),
    tx(jnChecking, 42, "Neighborhood Market", Groceries,  -67.80),
    tx(jnChecking, 50, "Neighborhood Market", Groceries,  -83.20),
    tx(jnChecking, 58, "Wholesale Club",      Groceries, -145.90),
    tx(jnChecking, 66, "Neighborhood Market", Groceries,  -75.60),
    tx(jnChecking, 74, "Neighborhood Market", Groceries,  -92.30),
    tx(jnChecking, 82, "Wholesale Club",      Groceries, -128.40),
    tx(jnChecking, 90, "Neighborhood Market", Groceries,  -68.70),
    // Utilities — electric ×4
    tx(jnChecking,  7, "City Power Co",       Utilities, -112.00),
    tx(jnChecking, 37, "City Power Co",       Utilities, -124.50),
    tx(jnChecking, 67, "City Power Co",       Utilities, -108.80),
    tx(jnChecking, 97, "City Power Co",       Utilities, -118.30),
    // Utilities — internet ×4
    tx(jnChecking,  8, "CableNet Pro",        Utilities,  -89.99),
    tx(jnChecking, 38, "CableNet Pro",        Utilities,  -89.99),
    tx(jnChecking, 68, "CableNet Pro",        Utilities,  -89.99),
    tx(jnChecking, 98, "CableNet Pro",        Utilities,  -89.99),
    // Utilities — phone ×4
    tx(jnChecking, 11, "MobileCarrier Plus",  Utilities,  -75.00),
    tx(jnChecking, 41, "MobileCarrier Plus",  Utilities,  -75.00),
    tx(jnChecking, 71, "MobileCarrier Plus",  Utilities,  -75.00),
    tx(jnChecking,101, "MobileCarrier Plus",  Utilities,  -75.00),
    // Subscriptions ×2 ×4
    tx(jnChecking,  1, "GamePass Ultimate",   Subscriptions, -14.99),
    tx(jnChecking, 31, "GamePass Ultimate",   Subscriptions, -14.99),
    tx(jnChecking, 61, "GamePass Ultimate",   Subscriptions, -14.99),
    tx(jnChecking, 91, "GamePass Ultimate",   Subscriptions, -14.99),
    tx(jnChecking,  1, "StreamPlus",          Subscriptions, -15.99),
    tx(jnChecking, 31, "StreamPlus",          Subscriptions, -15.99),
    tx(jnChecking, 61, "StreamPlus",          Subscriptions, -15.99),
    tx(jnChecking, 91, "StreamPlus",          Subscriptions, -15.99),
    // Transfer to savings ×5
    tx(jnChecking,  4, "Transfer to Savings", Transfer, -250),
    tx(jnChecking, 34, "Transfer to Savings", Transfer, -250),
    tx(jnChecking, 64, "Transfer to Savings", Transfer, -250),
    tx(jnChecking, 94, "Transfer to Savings", Transfer, -250),
    tx(jnChecking,114, "Transfer to Savings", Transfer, -250),
    // Auto loan payment ×4
    tx(jnChecking,  5, "Beacon Auto Loan Pmt",  Payment, -380),
    tx(jnChecking, 35, "Beacon Auto Loan Pmt",  Payment, -380),
    tx(jnChecking, 65, "Beacon Auto Loan Pmt",  Payment, -380),
    tx(jnChecking, 95, "Beacon Auto Loan Pmt",  Payment, -380),
    // Mortgage payment ×4
    tx(jnChecking,  6, "Beacon Mortgage Pmt", Payment, -1680),
    tx(jnChecking, 36, "Beacon Mortgage Pmt", Payment, -1680),
    tx(jnChecking, 66, "Beacon Mortgage Pmt", Payment, -1680),
    tx(jnChecking, 96, "Beacon Mortgage Pmt", Payment, -1680),
    // Healthcare ×4
    tx(jnChecking, 12, "HealthFirst Medical", Other, -180.00),
    tx(jnChecking, 42, "Vision Associates",   Other,  -85.00),
    tx(jnChecking, 72, "HealthFirst Medical", Other, -145.00),
    tx(jnChecking,102, "City Pharmacy",       Other,  -42.80),
    // Auto insurance ×4
    tx(jnChecking, 20, "AutoShield Insurance",Other, -168.00),
    tx(jnChecking, 50, "AutoShield Insurance",Other, -168.00),
    tx(jnChecking, 80, "AutoShield Insurance",Other, -168.00),
    tx(jnChecking,110, "AutoShield Insurance",Other, -168.00),
    // Gas ×6
    tx(jnChecking,  4, "Fuel Express",        Other,  -68.40),
    tx(jnChecking, 19, "Fuel Express",        Other,  -72.80),
    tx(jnChecking, 38, "Fuel Express",        Other,  -64.20),
    tx(jnChecking, 57, "Fuel Express",        Other,  -70.50),
    tx(jnChecking, 76, "Fuel Express",        Other,  -66.90),
    tx(jnChecking, 95, "Fuel Express",        Other,  -73.10),
    // Dining cash ×6
    tx(jnChecking,  8, "Sports Bar & Grill",   Dining,  -48.00),
    tx(jnChecking, 22, "Fast Food Drive-Thru", Dining,  -14.50),
    tx(jnChecking, 46, "Pizza Palace",         Dining,  -32.00),
    tx(jnChecking, 60, "Taco Run",             Dining,  -18.40),
    tx(jnChecking, 78, "Sports Bar & Grill",   Dining,  -52.00),
    tx(jnChecking,103, "Fast Food Drive-Thru", Dining,  -16.80),
  ]});

  await prisma.transaction.createMany({ data: [
    // John Savings ×10
    tx(jnSavings,  4, "Transfer from Checking", Transfer,  250),
    tx(jnSavings, 34, "Transfer from Checking", Transfer,  250),
    tx(jnSavings, 64, "Transfer from Checking", Transfer,  250),
    tx(jnSavings, 94, "Transfer from Checking", Transfer,  250),
    tx(jnSavings,114, "Transfer from Checking", Transfer,  250),
    tx(jnSavings, 10, "Interest Credit", Interest, 18.48, false, "Savings Interest — May 2026"),
    tx(jnSavings, 40, "Interest Credit", Interest, 17.92, false, "Savings Interest — Apr 2026"),
    tx(jnSavings, 70, "Interest Credit", Interest, 16.80, false, "Savings Interest — Mar 2026"),
    tx(jnSavings,100, "Interest Credit", Interest, 15.60, false, "Savings Interest — Feb 2026"),
    tx(jnSavings, 85, "Emergency Withdrawal", Transfer, -800, false, "Car repair fund transfer"),
  ]});

  await prisma.transaction.createMany({ data: [
    // John Credit Card — Dining ×12
    tx(jnCreditCard,  3, "Steakhouse Downtown",  Dining, -118.00),
    tx(jnCreditCard,  9, "Sports Bar & Grill",   Dining,  -68.40),
    tx(jnCreditCard, 15, "Sushi Fusion",         Dining,  -94.20),
    tx(jnCreditCard, 21, "Burger Joint",         Dining,  -24.80),
    tx(jnCreditCard, 28, "Mexican Grill",        Dining,  -52.60),
    tx(jnCreditCard, 34, "Steakhouse Downtown",  Dining, -102.40),
    tx(jnCreditCard, 41, "Pizza Artisano",       Dining,  -38.90),
    tx(jnCreditCard, 48, "Brunch Club",          Dining,  -64.50),
    tx(jnCreditCard, 55, "Ramen House",          Dining,  -42.80),
    tx(jnCreditCard, 63, "Sports Bar & Grill",   Dining,  -72.60),
    tx(jnCreditCard, 70, "Steakhouse Downtown",  Dining,  -88.40),
    tx(jnCreditCard, 78, "Mexican Grill",        Dining,  -46.20),
    // Shopping ×10
    tx(jnCreditCard,  5, "Electronics Superstore",Shopping,-349.00, true),
    tx(jnCreditCard, 11, "Sporting Goods",        Shopping,-185.00),
    tx(jnCreditCard, 19, "Amazon Marketplace",    Shopping, -89.99),
    tx(jnCreditCard, 27, "Men's Wearhouse",       Shopping,-240.00),
    tx(jnCreditCard, 33, "Best Buy",              Shopping,-149.99),
    tx(jnCreditCard, 45, "Amazon Marketplace",    Shopping, -67.40),
    tx(jnCreditCard, 53, "Sporting Goods",        Shopping, -92.00),
    tx(jnCreditCard, 61, "Home Depot",            Shopping,-314.80),
    tx(jnCreditCard, 75, "Amazon Marketplace",    Shopping, -45.99),
    tx(jnCreditCard, 88, "Best Buy",              Shopping,-219.00),
    // Travel ×4
    tx(jnCreditCard, 22, "Weekend Hotel",        Travel, -420.00),
    tx(jnCreditCard, 50, "Airline Ticket",       Travel, -580.00),
    tx(jnCreditCard, 72, "Hotel Stay",           Travel, -360.00),
    tx(jnCreditCard,100, "Rental Car",           Travel, -210.00),
    // Entertainment ×4
    tx(jnCreditCard,  7, "Concert Tickets",      Other, -210.00),
    tx(jnCreditCard, 38, "Sporting Event",       Other, -180.00),
    tx(jnCreditCard, 62, "Concert Tickets",      Other, -160.00),
    tx(jnCreditCard, 90, "Golf Course",          Other,  -85.00),
    // Gas on CC ×6
    tx(jnCreditCard, 14, "Fuel Express",         Other,  -72.40),
    tx(jnCreditCard, 29, "Fuel Express",         Other,  -68.80),
    tx(jnCreditCard, 46, "Fuel Express",         Other,  -74.20),
    tx(jnCreditCard, 65, "Fuel Express",         Other,  -69.50),
    tx(jnCreditCard, 83, "Fuel Express",         Other,  -71.90),
    tx(jnCreditCard,103, "Fuel Express",         Other,  -66.30),
    // CC payments ×4
    tx(jnCreditCard, 28, "CC Payment", Payment, -1200),
    tx(jnCreditCard, 58, "CC Payment", Payment,  -800),
    tx(jnCreditCard, 88, "CC Payment", Payment, -1000),
    tx(jnCreditCard,118, "CC Payment", Payment,  -900),
  ]});

  await prisma.transaction.createMany({ data: [
    // John Roth IRA ×8
    itx(jnRothIra, 10, "CONTRIBUTION", Income,   583,   "Monthly IRA Contribution — Jan"),
    itx(jnRothIra, 40, "CONTRIBUTION", Income,   583,   "Monthly IRA Contribution — Feb"),
    itx(jnRothIra, 70, "CONTRIBUTION", Income,   583,   "Monthly IRA Contribution — Mar"),
    itx(jnRothIra,100, "CONTRIBUTION", Income,   583,   "Monthly IRA Contribution — Apr"),
    itx(jnRothIra, 12, "VOO",  Buy,  -2940, "Buy 6 shares VOO @ $490"),
    itx(jnRothIra, 42, "SCHD", Buy,  -1560, "Buy 20 shares SCHD @ $78"),
    itx(jnRothIra, 72, "BND",  Buy,  -1480, "Buy 20 shares BND @ $74"),
    itx(jnRothIra, 95, "VXUS", Buy,   -975, "Buy 15 shares VXUS @ $65"),
    // John 401k ×10
    itx(jn401k,  3, "401k Contribution", Income,  360, "Employee contribution 8.5%"),
    itx(jn401k,  3, "401k Match",        Income,  180, "Employer match 50%"),
    itx(jn401k, 17, "401k Contribution", Income,  360, "Employee contribution 8.5%"),
    itx(jn401k, 17, "401k Match",        Income,  180, "Employer match 50%"),
    itx(jn401k, 31, "401k Contribution", Income,  360, "Employee contribution 8.5%"),
    itx(jn401k, 31, "401k Match",        Income,  180, "Employer match 50%"),
    itx(jn401k, 45, "401k Contribution", Income,  360, "Employee contribution 8.5%"),
    itx(jn401k, 45, "401k Match",        Income,  180, "Employer match 50%"),
    itx(jn401k, 20, "NVDA", Buy,  -1100, "Buy 1 share NVDA @ $1,100"),
    itx(jn401k, 50, "VOO",  Buy,  -4900, "Buy 10 shares VOO @ $490"),
    // John Taxable ×8
    itx(jnBrokerage, 15, "QQQ",  Buy,  -5700, "Buy 15 shares QQQ @ $380"),
    itx(jnBrokerage, 35, "AAPL", Buy,  -3900, "Buy 20 shares AAPL @ $195"),
    itx(jnBrokerage, 55, "MSFT", Buy,  -2100, "Buy 5 shares MSFT @ $420"),
    itx(jnBrokerage, 75, "AAPL", Sell,  1950, "Sell 10 shares AAPL — partial profit"),
    itx(jnBrokerage, 95, "QQQ",  Buy,  -1900, "Buy 5 shares QQQ @ $380"),
    itx(jnBrokerage, 30, "QQQ",  Dividend,  94.50, "QQQ Quarterly Dividend"),
    itx(jnBrokerage, 60, "AAPL", Dividend,  44.00, "AAPL Quarterly Dividend"),
    itx(jnBrokerage, 90, "MSFT", Dividend,  33.60, "MSFT Quarterly Dividend"),
    // John Crypto ×8
    itx(jnCryptoExchange,  8, "BTC",  Buy,  -3920, "Buy 0.04 BTC @ $98,000"),
    itx(jnCryptoExchange, 28, "ETH",  Buy,  -3300, "Buy 1.2 ETH @ $2,750"),
    itx(jnCryptoExchange, 50, "DOGE", Buy,   -180, "Buy 1,000 DOGE @ $0.18"),
    itx(jnCryptoExchange, 72, "ETH",  Sell,  1500, "Sell 0.55 ETH — partial profit"),
    itx(jnCryptoExchange, 90, "BTC",  Buy,  -1960, "Buy 0.02 BTC @ $98,000"),
    itx(jnCryptoExchange,110, "DOGE", Buy,   -360, "Buy 2,000 DOGE @ $0.18"),
    itx(jnCryptoExchange, 30, "ETH",  Dividend,  42.00, "ETH Staking Reward"),
    itx(jnCryptoExchange, 75, "ETH",  Dividend,  38.50, "ETH Staking Reward"),
    // John BTC Wallet ×3
    itx(jnBtcWallet, 40,  "BTC", Buy,  -3724, "Buy 0.038 BTC → self-custody"),
    itx(jnBtcWallet,100,  "BTC", Buy,  -1960, "Buy 0.02 BTC → self-custody"),
    itx(jnBtcWallet, 15,  "BTC", Sell,  2450, "Sell 0.025 BTC — partial exit"),
  ]});

  await prisma.transaction.createMany({ data: [
    // John Business Checking ×25
    tx(jnBizChecking,  8, "Acme Corp — Invoice #1042",      Income,  4500),
    tx(jnBizChecking, 22, "TechStart Inc — Invoice #1043",  Income,  3200),
    tx(jnBizChecking, 35, "Acme Corp — Invoice #1044",      Income,  4500),
    tx(jnBizChecking, 48, "Digital Media Co — Invoice #1045",Income, 2800),
    tx(jnBizChecking, 62, "Acme Corp — Invoice #1046",      Income,  4500),
    tx(jnBizChecking, 72, "TechStart Inc — Invoice #1047",  Income,  3200),
    tx(jnBizChecking, 85, "Digital Media Co — Invoice #1048",Income, 2800),
    tx(jnBizChecking,100, "Acme Corp — Invoice #1049",      Income,  4500),
    tx(jnBizChecking,112, "TechStart Inc — Invoice #1050",  Income,  3200),
    tx(jnBizChecking,  1, "GitHub Teams",       Subscriptions,  -48.00),
    tx(jnBizChecking, 31, "GitHub Teams",       Subscriptions,  -48.00),
    tx(jnBizChecking, 61, "GitHub Teams",       Subscriptions,  -48.00),
    tx(jnBizChecking, 91, "GitHub Teams",       Subscriptions,  -48.00),
    tx(jnBizChecking,  1, "AWS Cloud Services", Subscriptions, -180.00),
    tx(jnBizChecking, 31, "AWS Cloud Services", Subscriptions, -180.00),
    tx(jnBizChecking, 61, "AWS Cloud Services", Subscriptions, -180.00),
    tx(jnBizChecking, 91, "AWS Cloud Services", Subscriptions, -180.00),
    tx(jnBizChecking, 15, "Contractor — Design Work", Other, -800),
    tx(jnBizChecking, 45, "Contractor — Design Work", Other, -800),
    tx(jnBizChecking, 75, "Contractor — Design Work", Other, -800),
    tx(jnBizChecking,105, "Contractor — Design Work", Other, -800),
    tx(jnBizChecking, 25, "Transfer to Personal", Transfer, -2000),
    tx(jnBizChecking, 55, "Transfer to Personal", Transfer, -2000),
    tx(jnBizChecking, 85, "Transfer to Personal", Transfer, -2000),
    tx(jnBizChecking,115, "Transfer to Personal", Transfer, -2000),
    // John Business Card ×15
    tx(jnBizCard,  5, "Client Dinner — Steakhouse", Dining, -284.00),
    tx(jnBizCard, 25, "Team Lunch",                 Dining,  -92.40),
    tx(jnBizCard, 48, "Client Dinner — Italian",    Dining, -246.80),
    tx(jnBizCard, 65, "Team Lunch",                 Dining,  -88.60),
    tx(jnBizCard, 80, "Client Dinner — Steakhouse", Dining, -318.40),
    tx(jnBizCard,100, "Team Lunch",                 Dining,  -94.20),
    tx(jnBizCard,  1, "Figma Pro",                  Subscriptions, -45.00),
    tx(jnBizCard, 31, "Figma Pro",                  Subscriptions, -45.00),
    tx(jnBizCard, 61, "Figma Pro",                  Subscriptions, -45.00),
    tx(jnBizCard, 91, "Figma Pro",                  Subscriptions, -45.00),
    tx(jnBizCard, 12, "Office Depot",               Shopping,  -84.50),
    tx(jnBizCard, 52, "Office Depot",               Shopping,  -62.30),
    tx(jnBizCard, 92, "Office Depot",               Shopping,  -95.80),
    tx(jnBizCard, 30, "Conference Hotel",            Travel,  -645.00),
    tx(jnBizCard, 90, "Flight — Business",           Travel,  -380.00),
  ]});
  console.log("   ✓ John transactions: ~210");

  // John — AI Advice
  await prisma.aiAdvice.create({
    data: {
      spaceId: johnSpace.id, agentId: johnAgent.id,
      summary: "High debt load, thin cash reserves — eliminate the CC before any new investments.",
      adviceText: `**Market Context (June 2026):** BTC ~$98,000. S&P 500 steady. Rates elevated.

**Your Position:**
- Cash: **$2,100** (~0.5 months expenses — thin)
- Savings: **$5,500** (below 3-month cushion)
- Roth IRA: **$28,500** — well diversified (VOO/SCHD/BND/VXUS/VNQ)
- 401k: **$18,200** — tech-heavy (NVDA + TSLA = 46%)
- Taxable: **$12,800** — QQQ/AAPL/MSFT concentration
- Crypto: **$11,124** — BTC/ETH/DOGE across exchange + wallet
- Debt: **$302,100** ($5.8k CC 22.99% | $11.2k auto 6.49% | $285k mortgage 3.875%)
- Business equity: ~$6.3k net
- Net worth: ~**$77,824**

**Priority Actions:**
1. Kill the CC — 22.99% APR is wealth destruction
2. Build emergency fund to $12,000+
3. Rebalance 401k toward VOO/diversified ETF (NVDA + TSLA overweight)
4. Mortgage is low rate (3.875%) — don't overpay while CC exists
5. Business revenue strong — keep profit draws consistent

**Risk Level: Medium-High** | **Action Ready: No**`,
      riskLevel: "medium", actionReady: false, generatedAt: new Date("2026-06-09T09:00:00Z"),
    },
  });

  // John — Snapshots
  await prisma.spaceSnapshot.createMany({ data: buildJohnHistory(johnSpace.id) });
  console.log("   ✓ SpaceSnapshots (John): 365");

  // Shared space snapshots
  await prisma.spaceSnapshot.createMany({ data: buildHouseholdHistory(householdSpace.id) });
  await prisma.spaceSnapshot.createMany({ data: buildDebtHistory(debtSpace.id) });
  console.log("   ✓ SpaceSnapshots (Household 120, Debt 90)");

  // ── Space Goals ──────────────────────────────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const goalCreate = (data: any) => (prisma.spaceGoal as any).create({ data });

  const goalJaneEmergencyFund = await goalCreate({
    spaceId: householdSpace.id, createdByUserId: jane.id,
    name: "6-Month Emergency Fund", description: "Build a combined emergency fund covering 6 months of household expenses (~$20k)",
    category: GoalCategory.EMERGENCY_FUND, goalType: GoalType.FINANCIAL,
    status: GoalStatus.ACTIVE, targetAmount: 20000, currentAmount: 11740,
    targetDate: new Date("2027-01-01"),
  });
  const goalJaneJapan = await goalCreate({
    spaceId: japanSpace.id, createdByUserId: jane.id,
    name: "Japan Trip 2027 Fund", description: "Save $8,500 for flights, accommodation, and spending money",
    category: GoalCategory.TRIP, goalType: GoalType.FINANCIAL,
    status: GoalStatus.ACTIVE, targetAmount: 8500, currentAmount: 3240,
    targetDate: new Date("2027-03-01"),
  });
  const goalJaneCCPayoff = await goalCreate({
    spaceId: janeSpace.id, createdByUserId: jane.id,
    name: "Pay Off CU Credit Card", description: "Eliminate $3,200 balance at 19.99% APR",
    category: GoalCategory.DEBT_PAYOFF, goalType: GoalType.DEBT_REDUCTION,
    status: GoalStatus.ACTIVE, targetAmount: 3200, currentAmount: 2100,
    linkedAccountId: jCreditCard.id, snapshotBalance: 3200, targetReductionAmount: 3200,
  });
  const _goalJaneExercise = await goalCreate({
    spaceId: janeSpace.id, createdByUserId: jane.id,
    name: "Daily Exercise Streak", description: "30-minute workout every day — building the habit",
    category: GoalCategory.GENERAL, goalType: GoalType.HABIT,
    status: GoalStatus.ACTIVE, habitFrequency: "DAILY", currentStreak: 12, longestStreak: 28,
    lastCheckIn: D(1),
  });
  const _goalJaneDiningBudget = await goalCreate({
    spaceId: janeSpace.id, createdByUserId: jane.id,
    name: "Dining Budget — $300/mo", description: "Keep dining + coffee under $300/month",
    category: GoalCategory.GENERAL, goalType: GoalType.SPENDING_LIMIT,
    status: GoalStatus.ACTIVE, targetAmount: 300, spendingCategory: "Dining",
  });
  const goalJohnCCElim = await goalCreate({
    spaceId: debtSpace.id, createdByUserId: john.id,
    name: "Beacon CC Elimination",  description: "Pay off Beacon Credit Card ($5,800 at 22.99% APR) — highest priority debt",
    category: GoalCategory.DEBT_PAYOFF, goalType: GoalType.DEBT_REDUCTION,
    status: GoalStatus.ACTIVE, targetAmount: 5800, currentAmount: 3200,
    linkedAccountId: jnCreditCard.id, snapshotBalance: 5800, targetReductionAmount: 5800,
  });
  const goalJohnAutoLoan = await goalCreate({
    spaceId: debtSpace.id, createdByUserId: john.id,
    name: "Auto Loan Payoff", description: "Accelerate payoff of $11,200 auto loan (6.49% APR)",
    category: GoalCategory.DEBT_PAYOFF, goalType: GoalType.DEBT_REDUCTION,
    status: GoalStatus.ACTIVE, targetAmount: 11200, currentAmount: 4000,
    linkedAccountId: jnAutoLoan.id, snapshotBalance: 11200, targetReductionAmount: 11200,
    targetDate: new Date("2028-06-01"),
  });
  const goalJohnRothMax = await goalCreate({
    spaceId: investmentSpace.id, createdByUserId: john.id,
    name: "Max Roth IRA 2026", description: "Contribute full $7,000 to Roth IRA this calendar year",
    category: GoalCategory.INVESTMENT, goalType: GoalType.FINANCIAL,
    status: GoalStatus.ACTIVE, targetAmount: 7000, currentAmount: 2332,
    targetDate: new Date("2026-12-31"),
  });
  const _goalJohnRenovation = await goalCreate({
    spaceId: propertySpace.id, createdByUserId: john.id,
    name: "Home Renovation Fund", description: "Kitchen + master bath renovation — paused pending CC payoff",
    category: GoalCategory.HOME_PURCHASE, goalType: GoalType.FINANCIAL,
    status: GoalStatus.PAUSED, targetAmount: 25000, currentAmount: 0,
    targetDate: new Date("2028-01-01"),
  });
  // Completed goal — earlier Japan research fund
  const _goalJaneCompleted = await goalCreate({
    spaceId: janeSpace.id, createdByUserId: jane.id,
    name: "Japan Research Budget", description: "Fund for Japan trip research and flight booking deposit",
    category: GoalCategory.TRIP, goalType: GoalType.FINANCIAL,
    status: GoalStatus.COMPLETED, targetAmount: 1000, currentAmount: 1000,
    targetDate: new Date("2026-03-01"), completedAt: D(45),
  });
  console.log("   ✓ SpaceGoals: 10");

  // ── Goal Contributions ────────────────────────────────────────────────────────
  await prisma.goalContribution.createMany({
    data: [
      { goalId: goalJaneEmergencyFund.id, financialAccountId: jDemoHysa.id,     includeBalance: true },
      { goalId: goalJaneEmergencyFund.id, financialAccountId: jnSavings.id,     includeBalance: true },
      { goalId: goalJaneJapan.id,         financialAccountId: jJapanSavings.id, includeBalance: true },
      { goalId: goalJaneCCPayoff.id,      financialAccountId: jCreditCard.id,   includeBalance: true },
      { goalId: goalJohnCCElim.id,        financialAccountId: jnCreditCard.id,  includeBalance: true },
      { goalId: goalJohnAutoLoan.id,      financialAccountId: jnAutoLoan.id,    includeBalance: true },
      { goalId: goalJohnRothMax.id,       financialAccountId: jnRothIra.id,     includeBalance: false },
    ],
  });
  console.log("   ✓ GoalContributions: 7");

  // ── Audit Log ─────────────────────────────────────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const log = (userId: string, spaceId: string | null, action: string, metadata?: any, createdAt?: Date) =>
    ({ userId, spaceId, action, metadata: metadata ?? {}, ...(createdAt ? { createdAt } : {}) });

  // Helper: minutes-ago offset so events within the same day are ordered properly.
  // Larger offset = older event. Events are listed oldest → newest, each 5 min apart.
  const T = (daysAgo: number, minutesAgo = 0) => {
    const d = D(daysAgo);
    d.setMinutes(d.getMinutes() - minutesAgo);
    return d;
  };

  await prisma.auditLog.createMany({
    data: [
      // ── Space creation trails (oldest events get highest offsets) ─────────
      // Personal spaces (created ~90 days ago)
      log(jane.id, janeSpace.id,      "SPACE_CREATED",  { name: "Jane's Space",    category: "PERSONAL"   }, T(90)),
      log(john.id, johnSpace.id,      "SPACE_CREATED",  { name: "John's Space",    category: "PERSONAL"   }, T(90)),

      // Household space (created ~60 days ago, events staggered 5 min apart)
      log(jane.id, householdSpace.id, "SPACE_CREATED",  { name: "Smith-Doe Household", category: "HOUSEHOLD"  }, T(60, 20)),
      log(john.id, householdSpace.id, "MEMBER_INVITED",     { invitedEmail: "john@example.com", role: "MEMBER" },    T(60, 15)),
      log(john.id, householdSpace.id, "MEMBER_JOINED",      { role: "MEMBER" },                                     T(60, 10)),
      log(jane.id, householdSpace.id, "ACCOUNT_SHARED",     { accountName: "Demo Bank Checking",           visibility: "FULL"         }, T(60, 5)),
      log(jane.id, householdSpace.id, "ACCOUNT_SHARED",     { accountName: "Demo Bank High Yield Savings", visibility: "BALANCE_ONLY" }, T(60, 4)),
      log(john.id, householdSpace.id, "ACCOUNT_SHARED",     { accountName: "Beacon Bank Checking",         visibility: "FULL"         }, T(60, 3)),
      log(john.id, householdSpace.id, "ACCOUNT_SHARED",     { accountName: "Beacon Mortgage",              visibility: "FULL"         }, T(60, 2)),

      // Debt Payoff Tracker (created ~30 days ago)
      log(john.id, debtSpace.id,      "SPACE_CREATED",  { name: "Debt Payoff Tracker", category: "DEBT_PAYOFF" }, T(30, 20)),
      log(john.id, debtSpace.id,      "MEMBER_INVITED",     { invitedEmail: "jane@example.com", role: "MEMBER" },     T(30, 15)),
      log(jane.id, debtSpace.id,      "MEMBER_JOINED",      { role: "MEMBER" },                                      T(30, 10)),
      log(john.id, debtSpace.id,      "ACCOUNT_SHARED",     { accountName: "Beacon Credit Card",     visibility: "FULL"         }, T(30, 5)),
      log(john.id, debtSpace.id,      "ACCOUNT_SHARED",     { accountName: "Beacon Auto Loan",       visibility: "FULL"         }, T(30, 4)),
      log(jane.id, debtSpace.id,      "ACCOUNT_SHARED",     { accountName: "Example CU Credit Card", visibility: "BALANCE_ONLY" }, T(30, 3)),

      // Japan Trip space (created ~20 days ago)
      log(jane.id, japanSpace.id,     "SPACE_CREATED",  { name: "Japan Trip 2027", category: "TRIP"   }, T(20, 15)),
      log(jane.id, japanSpace.id,     "MEMBER_INVITED",     { invitedEmail: "john@example.com", role: "MEMBER" }, T(20, 10)),
      log(john.id, japanSpace.id,     "MEMBER_JOINED",      { role: "MEMBER" },                                  T(20,  5)),

      // Investment Club (created ~14 days ago)
      log(john.id, investmentSpace.id,"SPACE_CREATED",  { name: "Investment Club",  category: "INVESTMENT" }, T(14, 15)),
      log(john.id, investmentSpace.id,"MEMBER_INVITED",     { invitedEmail: "alex@example.com", role: "VIEWER" }, T(14, 10)),
      log(alex.id, investmentSpace.id,"MEMBER_JOINED",      { role: "VIEWER" },                                  T(14,  5)),

      // JD Freelance LLC (created ~7 days ago)
      log(john.id, businessSpace.id,  "SPACE_CREATED",  { name: "JD Freelance LLC", category: "BUSINESS" }, T(7, 15)),
      log(john.id, businessSpace.id,  "MEMBER_INVITED",     { invitedEmail: "alex@example.com", role: "ADMIN" }, T(7, 10)),
      log(alex.id, businessSpace.id,  "MEMBER_JOINED",      { role: "ADMIN" },                                  T(7,  5)),

      // Austin Home (created ~3 days ago)
      log(john.id, propertySpace.id,  "SPACE_CREATED",  { name: "Austin Home", category: "PROPERTY" }, T(3, 15)),
      log(john.id, propertySpace.id,  "MEMBER_INVITED",     { invitedEmail: "jane@example.com", role: "ADMIN" }, T(3, 10)),
      log(jane.id, propertySpace.id,  "MEMBER_JOINED",      { role: "ADMIN" },                                  T(3,  5)),

      // ── Recent activity (today / yesterday) ──────────────────────────────────
      log(jane.id, janeSpace.id,      "GOAL_CREATED",       { goalName: "Pay Off CU Credit Card", category: "DEBT_PAYOFF" }, T(2)),
      log(john.id, debtSpace.id,      "GOAL_CREATED",       { goalName: "Beacon CC Elimination",  category: "DEBT_PAYOFF" }, T(1)),
      log(jane.id, janeSpace.id,      "GOAL_COMPLETED",     { goalName: "Japan Research Budget",  completedAt: D(45).toISOString() }, T(0, 30)),
      log(john.id, null,                  "TOTP_ENABLED",       { method: "authenticator_app" }),
      log(admin.id,null,                  "SEED",               { note: "Comprehensive demo seed — dev only" }),
    ],
  });
  console.log("   ✓ AuditLog: 32 events");

  console.log("\n✅  Seed complete.");
  console.log("─── Jane Smith ──────────────────────────────────────────────────────────────");
  console.log(`   Space:  ${janeSpace.name} (id: ${janeSpace.id})`);
  console.log("   Accounts:   9 (checking, HYSA, Japan savings, CU checking, CC, IRA, taxable, crypto, BTC)");
  console.log("   Net worth:  ~$28,700  |  CC debt: $3,200  |  FICO: 720  |  Action ready: YES");
  console.log("─── John Doe ────────────────────────────────────────────────────────────────");
  console.log(`   Space:  ${johnSpace.name} (id: ${johnSpace.id})`);
  console.log("   Accounts:   12 (checking, savings, CC, auto, mortgage, Roth, 401k, taxable, crypto, BTC, biz checking, biz CC)");
  console.log("   Net worth:  ~$77,800  |  Debt: $302k  |  FICO: 680  |  Action ready: NO");
  console.log("─── Alex Chen ───────────────────────────────────────────────────────────────");
  console.log(`   No personal accounts — viewer/bookkeeper role only`);
  console.log("   FICO: 750");
  console.log("─── Shared Spaces ───────────────────────────────────────────────────────");
  console.log(`   ${householdSpace.name}  — Jane (OWNER) + John (MEMBER)`);
  console.log(`   ${debtSpace.name}      — John (OWNER) + Jane (MEMBER)`);
  console.log(`   ${japanSpace.name}          — Jane (OWNER) + John (MEMBER)`);
  console.log(`   ${investmentSpace.name}      — John (OWNER) + Jane (MEMBER) + Alex (VIEWER)`);
  console.log(`   ${businessSpace.name}       — John (OWNER) + Alex (ADMIN)`);
  console.log(`   ${propertySpace.name}             — John (OWNER) + Jane (ADMIN)`);
  console.log("\n🔑  Demo credentials (⚠️  local dev only — never use in production):");
  console.log(`   jane@example.com      (@janesmith)  /  ${JANE_PASSWORD}    [USER]`);
  console.log(`   john@example.com      (@johndoe)    /  ${JANE_PASSWORD}    [USER]`);
  console.log(`   alex@example.com      (@alexchen)   /  ${JANE_PASSWORD}    [USER]`);
  console.log(`   sysadmin@example.com  (@sysadmin)   /  ${ADMIN_PASSWORD}   [SYSTEM_ADMIN — DEV ONLY]`);
}

main()
  .catch((e) => { console.error("❌  Seed failed:", e); process.exit(1); })
  .finally(() => prisma.$disconnect());
