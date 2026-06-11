/**
 * prisma/seed.ts
 *
 * Populates the database with two demo users, a shared workspace,
 * an AI agent, and a fictional portfolio for local development.
 *
 * All data is entirely fictional. No real names, balances, wallet
 * addresses, account numbers, or institution identifiers are used.
 *
 * Run via:  npx prisma db seed
 *
 * Safe to re-run — all data is wiped and recreated cleanly.
 * Wipe order respects FK constraints:
 *   AuditLog → AiAdvice → WorkspaceSnapshot → Transaction → Holding
 *   → Account → PlaidItem → AiAgent → WorkspaceMember
 *   → Workspace → CreditScore → User
 *
 * ─── Demo credentials ────────────────────────────────────────────
 *   jane@example.com  / janesmith  →  ChangeMe123!
 *   john@example.com  / johndoe    →  ChangeMe123!
 *   admin@example.com / admin      →  ChangeMe123!
 *
 * ⚠️  These are local dev credentials only.
 *     Change them before any real deployment.
 * ─────────────────────────────────────────────────────────────────
 */

import {
  PrismaClient,
  AccountType,
  TransactionCategory,
  PlaidItemStatus,
  WorkspaceMemberRole,
  UserRole,
  EmploymentStatus,
  UseCase,
} from "@prisma/client";
import bcrypt from "bcryptjs";
import { encrypt } from "../lib/plaid/encryption";

const prisma = new PrismaClient();

// ─── Password resolution ──────────────────────────────────────────────────────
// Override via env vars in CI or staging. Defaults are demo-only.
const JANE_PASSWORD  = process.env.SEED_USER_PASSWORD  ?? "ChangeMe123!";
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? "ChangeMe123!";

// ─── Seeded deterministic random ─────────────────────────────────────────────
function seededRand(seed: number): number {
  const x = Math.sin(seed + 1) * 10000;
  return x - Math.floor(x);
}

// ─── 365-day history generator ───────────────────────────────────────────────
// Fictional portfolio (June 2026):
//   cash     ~$4,200   (Demo Bank Checking + Example CU Checking)
//   savings  ~$8,500   (Demo Bank HYSA)
//   stocks   ~$12,400  (Sample Brokerage)
//   crypto   ~$6,800   (Fictional Crypto Exchange + Demo Wallet)
//   debt     ~$3,200   (Demo Credit Card)
//   netWorth ~$28,700
function buildHistory(workspaceId: string) {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  return Array.from({ length: 365 }, (_, i) => {
    const date = new Date(today);
    date.setDate(today.getUTCDate() - (364 - i));
    date.setUTCHours(0, 0, 0, 0);

    const t = i / 364; // 0 → 1 over the year

    // Stocks: grew from ~$8,000 to ~$12,400
    const stocks  = Math.max(Math.round(8000 + t * 4400 + Math.sin(i * 0.09) * 500 + (seededRand(i) - 0.5) * 400), 0);
    // Crypto: moderate volatility
    const crypto  = Math.max(Math.round(4000 + t * 2800 + Math.sin(i * 0.11) * 1200 + (seededRand(i + 99) - 0.42) * 800), 0);
    // Cash: bounces around income/expense cycles
    const cash    = Math.max(Math.round(3800 + Math.sin(i * 0.08) * 600 + (seededRand(i + 33) - 0.5) * 400), 0);
    // Savings: slow steady growth
    const savings = Math.max(Math.round(5500 + t * 3000 + (seededRand(i + 77) - 0.5) * 100), 0);
    // Debt: credit card balance — declining over the year
    const debt    = Math.abs(Math.round(5200 - t * 2000 + Math.sin(i * 0.05) * 300 + (seededRand(i + 55) - 0.5) * 200));

    const total       = stocks + crypto;
    const totalAssets = stocks + crypto + cash + savings;
    const netWorth    = totalAssets - debt;
    const netLiquid   = cash + savings - debt;
    const cashToPlay  = cash + Math.max(savings - 6000, 0);

    return { workspaceId, date, stocks, crypto, total, cash, savings, debt, netWorth, totalAssets, netLiquid, cashToPlay };
  });
}

// ─── 365-day history generator (John — medium risk) ──────────────────────────
// Fictional portfolio (June 2026):
//   cash     ~$2,100   (Beacon Bank Checking)
//   savings  ~$5,500   (Beacon Bank Savings)
//   stocks   ~$18,200  (Alpha Brokerage 401k — tech-concentrated)
//   crypto   ~$7,400   (Alpha Crypto Exchange)
//   debt     ~$17,000  (Beacon Credit Card $5,800 + Auto Loan $11,200)
//   netWorth ~$16,200
function buildJohnHistory(workspaceId: string) {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  return Array.from({ length: 365 }, (_, i) => {
    const date = new Date(today);
    date.setDate(today.getUTCDate() - (364 - i));
    date.setUTCHours(0, 0, 0, 0);

    const t = i / 364;

    // 401k: grew from ~$12,000 to ~$18,200
    const stocks  = Math.max(Math.round(12000 + t * 6200 + Math.sin(i * 0.09) * 800 + (seededRand(i + 200) - 0.5) * 600), 0);
    // Crypto: higher volatility, grew from ~$4,500 to ~$7,400
    const crypto  = Math.max(Math.round(4500 + t * 2900 + Math.sin(i * 0.12) * 1500 + (seededRand(i + 300) - 0.42) * 1000), 0);
    // Cash: thin buffer, bouncy
    const cash    = Math.max(Math.round(1800 + Math.sin(i * 0.07) * 400 + (seededRand(i + 133) - 0.5) * 300), 0);
    // Savings: slow growth from $3,000
    const savings = Math.max(Math.round(3000 + t * 2500 + (seededRand(i + 177) - 0.5) * 150), 0);
    // Debt: declining from ~$22,000 (credit card + auto) to ~$17,000
    const debt    = Math.abs(Math.round(22000 - t * 5000 + Math.sin(i * 0.04) * 400 + (seededRand(i + 155) - 0.5) * 300));

    const total       = stocks + crypto;
    const totalAssets = stocks + crypto + cash + savings;
    const netWorth    = totalAssets - debt;
    const netLiquid   = cash + savings - debt;
    const cashToPlay  = Math.max(cash + Math.max(savings - 8000, 0), 0);

    return { workspaceId, date, stocks, crypto, total, cash, savings, debt, netWorth, totalAssets, netLiquid, cashToPlay };
  });
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log("🌱  Seeding FinTracker database…");

  // Hash passwords up front
  console.log("   ⏳ Hashing passwords (bcrypt cost 12)…");
  const [janeHash, johnHash, adminHash] = await Promise.all([
    bcrypt.hash(JANE_PASSWORD,  12),
    bcrypt.hash(JANE_PASSWORD,  12), // John uses same default; both must change
    bcrypt.hash(ADMIN_PASSWORD, 12),
  ]);

  // Fictional DOBs — no real personal data
  const janeDobEncrypted = encrypt("1990-03-15");
  const johnDobEncrypted = encrypt("1988-07-22");

  // ── Wipe in reverse-dependency order ─────────────────────────────────────
  await prisma.auditLog.deleteMany();
  await prisma.aiAdvice.deleteMany();
  await prisma.workspaceSnapshot.deleteMany();
  await prisma.transaction.deleteMany();
  await prisma.holding.deleteMany();
  await prisma.account.deleteMany();
  await prisma.plaidItem.deleteMany();
  await prisma.aiAgent.deleteMany();
  await prisma.workspaceMember.deleteMany();
  await prisma.workspace.deleteMany();
  await prisma.creditScore.deleteMany();
  await prisma.user.deleteMany();

  // ── Users ─────────────────────────────────────────────────────────────────
  const jane = await prisma.user.create({
    data: {
      email:                "jane@example.com",
      username:             "janesmith",
      name:                 "Jane Smith",
      firstName:            "Jane",
      lastName:             "Smith",
      dateOfBirthEncrypted: janeDobEncrypted,
      employmentStatus:     EmploymentStatus.EMPLOYED,
      useCase:              UseCase.PERSONAL_TRACKING,
      passwordHash:         janeHash,
      role:                 UserRole.USER,
    },
  });
  console.log(`   ✓ User: ${jane.email} (@${jane.username}) (USER)`);

  const john = await prisma.user.create({
    data: {
      email:                "john@example.com",
      username:             "johndoe",
      name:                 "John Doe",
      firstName:            "John",
      lastName:             "Doe",
      dateOfBirthEncrypted: johnDobEncrypted,
      employmentStatus:     EmploymentStatus.EMPLOYED,
      useCase:              UseCase.PERSONAL_TRACKING,
      passwordHash:         johnHash,
      role:                 UserRole.USER,
    },
  });
  console.log(`   ✓ User: ${john.email} (@${john.username}) (USER)`);

  const admin = await prisma.user.create({
    data: {
      email:        "admin@example.com",
      username:     "admin",
      name:         "System Admin",
      passwordHash: adminHash,
      role:         UserRole.SYSTEM_ADMIN,
    },
  });
  console.log(`   ✓ User: ${admin.email} (@${admin.username}) (SYSTEM_ADMIN)`);

  // ── Workspaces ────────────────────────────────────────────────────────────
  const janeWorkspace = await prisma.workspace.create({
    data: { name: "Jane's Dashboard", type: "PERSONAL" },
  });
  console.log(`   ✓ Workspace: ${janeWorkspace.name} (PERSONAL)`);

  const johnWorkspace = await prisma.workspace.create({
    data: { name: "John's Dashboard", type: "PERSONAL" },
  });
  console.log(`   ✓ Workspace: ${johnWorkspace.name} (PERSONAL)`);

  const sharedWorkspace = await prisma.workspace.create({
    data: {
      name:        "Smith-Doe Household",
      type:        "SHARED",
      isPublic:    false,
      description: "Shared household finances for Jane & John",
    },
  });
  console.log(`   ✓ Workspace: ${sharedWorkspace.name} (SHARED)`);

  // ── WorkspaceMembers ──────────────────────────────────────────────────────
  await prisma.workspaceMember.createMany({
    data: [
      { workspaceId: janeWorkspace.id,    userId: jane.id, role: WorkspaceMemberRole.OWNER  },
      { workspaceId: johnWorkspace.id,    userId: john.id, role: WorkspaceMemberRole.OWNER  },
      { workspaceId: sharedWorkspace.id,  userId: jane.id, role: WorkspaceMemberRole.OWNER  },
      { workspaceId: sharedWorkspace.id,  userId: john.id, role: WorkspaceMemberRole.MEMBER },
    ],
  });
  console.log("   ✓ WorkspaceMembers: Jane (OWNER×2), John (MEMBER×1)");

  // ── AiAgent ───────────────────────────────────────────────────────────────
  const agent = await prisma.aiAgent.create({
    data: { workspaceId: janeWorkspace.id, name: "Jane's Financial Agent" },
  });
  console.log(`   ✓ AiAgent: ${agent.name}`);

  // ── CreditScore ───────────────────────────────────────────────────────────
  await prisma.creditScore.create({
    data: {
      userId:     jane.id,
      score:      720,
      source:     "manual",
      recordedAt: new Date("2026-06-01T10:00:00Z"),
    },
  });
  console.log("   ✓ CreditScore: 720 (manual)");

  // ── PlaidItems — fictional institutions only ──────────────────────────────
  const plaidItems = await prisma.plaidItem.createManyAndReturn({
    data: [
      {
        userId:          jane.id,
        plaidItemId:     "demo_item_demobank",
        institutionId:   "demo_ins_001",
        institutionName: "Demo Bank",
        encryptedToken:  "[demo-placeholder-not-a-real-token]",
        status:          PlaidItemStatus.ACTIVE,
      },
      {
        userId:          jane.id,
        plaidItemId:     "demo_item_examplecu",
        institutionId:   "demo_ins_002",
        institutionName: "Example Credit Union",
        encryptedToken:  "[demo-placeholder-not-a-real-token]",
        status:          PlaidItemStatus.ACTIVE,
      },
      {
        userId:          jane.id,
        plaidItemId:     "demo_item_samplebrokerage",
        institutionId:   "demo_ins_003",
        institutionName: "Sample Brokerage",
        encryptedToken:  "[demo-placeholder-not-a-real-token]",
        status:          PlaidItemStatus.ACTIVE,
      },
      {
        userId:          jane.id,
        plaidItemId:     "demo_item_fictionalcrypto",
        institutionId:   "demo_ins_004",
        institutionName: "Fictional Crypto Exchange",
        encryptedToken:  "[demo-placeholder-not-a-real-token]",
        status:          PlaidItemStatus.ACTIVE,
      },
    ],
  });

  const itemBy = Object.fromEntries(
    plaidItems.map((p) => [(p as { institutionName: string }).institutionName, p])
  ) as Record<string, typeof plaidItems[0]>;
  console.log(`   ✓ PlaidItems: ${plaidItems.length}`);

  // ── Accounts ──────────────────────────────────────────────────────────────
  const accounts = await prisma.account.createManyAndReturn({
    data: [
      // ── Demo Bank ─────────────────────────────────────────────────────────
      {
        workspaceId: janeWorkspace.id, ownerId: jane.id,
        name: "Demo Bank Checking",       type: AccountType.checking,
        institution: "Demo Bank",         balance: 3450.00, availableBalance: 3450.00,

        currency: "USD", lastUpdated: new Date("2026-06-09T10:00:00Z"),
        plaidItemDbId: itemBy["Demo Bank"].id,
      },
      {
        workspaceId: janeWorkspace.id, ownerId: jane.id,
        name: "Demo Bank High Yield Savings", type: AccountType.savings,
        institution: "Demo Bank",         balance: 8500.00, availableBalance: 8500.00,
        currency: "USD", lastUpdated: new Date("2026-06-09T10:00:00Z"),
        plaidItemDbId: itemBy["Demo Bank"].id,
      },
      // ── Example Credit Union ──────────────────────────────────────────────
      {
        workspaceId: janeWorkspace.id, ownerId: jane.id,
        name: "Example CU Checking",      type: AccountType.checking,
        institution: "Example Credit Union", balance: 750.00, availableBalance: 750.00,
        currency: "USD", lastUpdated: new Date("2026-06-09T10:00:00Z"),
        plaidItemDbId: itemBy["Example Credit Union"].id,
      },
      {
        workspaceId: janeWorkspace.id, ownerId: jane.id,
        name: "Demo Credit Card",         type: AccountType.debt,
        institution: "Example Credit Union", balance: 3200.00, creditLimit: 10000,
        currency: "USD", lastUpdated: new Date("2026-06-09T10:00:00Z"),
        plaidItemDbId: itemBy["Example Credit Union"].id,
      },
      // ── Sample Brokerage ──────────────────────────────────────────────────
      {
        workspaceId: janeWorkspace.id, ownerId: jane.id,
        name: "Sample Brokerage IRA",     type: AccountType.investment,
        institution: "Sample Brokerage",  balance: 9200.00,
        currency: "USD", lastUpdated: new Date("2026-06-09T10:00:00Z"),
        plaidItemDbId: itemBy["Sample Brokerage"].id,
      },
      {
        workspaceId: janeWorkspace.id, ownerId: jane.id,
        name: "Sample Brokerage Taxable", type: AccountType.investment,
        institution: "Sample Brokerage",  balance: 3200.00,
        currency: "USD", lastUpdated: new Date("2026-06-09T10:00:00Z"),
        plaidItemDbId: itemBy["Sample Brokerage"].id,
      },
      // ── Fictional Crypto Exchange ─────────────────────────────────────────
      {
        workspaceId: janeWorkspace.id, ownerId: jane.id,
        name: "Fictional Crypto Exchange", type: AccountType.crypto,
        institution: "Fictional Crypto Exchange", balance: 4850.00,
        currency: "USD", lastUpdated: new Date("2026-06-09T10:00:00Z"),
        plaidItemDbId: itemBy["Fictional Crypto Exchange"].id,
      },
      // ── Self-custodied demo wallet (fake address) ─────────────────────────
      {
        workspaceId: janeWorkspace.id, ownerId: jane.id,
        name: "Demo BTC Wallet",          type: AccountType.crypto,
        institution: "Self-custodied",    balance: 1950.00,
        currency: "USD", lastUpdated: new Date("2026-06-09T10:05:00Z"),
        // Fictional/invalid address — not a real wallet
        walletAddress: "bc1demo000000000000000000000000000000000000",
        walletChain: "BTC", nativeBalance: 0.02, syncStatus: "synced",
      },
    ],
  });

  const byName: Record<string, typeof accounts[0]> = Object.fromEntries(
    accounts.map((a) => [a.name, a])
  );
  console.log(`   ✓ Accounts: ${accounts.length}`);

  // ── Holdings ──────────────────────────────────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (prisma.holding as any).createMany({
    data: [
      // ── Sample Brokerage IRA ──────────────────────────────────────────────
      { accountId: byName["Sample Brokerage IRA"].id,     symbol: "VOO",  name: "Vanguard S&P 500 ETF",     quantity: 18,     price: 490.00, value: 8820.00, change24h:  0.6 },
      { accountId: byName["Sample Brokerage IRA"].id,     symbol: "QQQ",  name: "Invesco QQQ Trust",         quantity:  1,     price: 380.00, value:  380.00, change24h:  1.1 },
      { accountId: byName["Sample Brokerage IRA"].id,     symbol: "CASH", name: "Uninvested Cash",           quantity:  0.00,  price:   1.00, value:    0.00, change24h:  0,   isCash: true },

      // ── Sample Brokerage Taxable ──────────────────────────────────────────
      { accountId: byName["Sample Brokerage Taxable"].id, symbol: "AAPL", name: "Apple Inc",                 quantity:  8,     price: 195.00, value: 1560.00, change24h:  0.4 },
      { accountId: byName["Sample Brokerage Taxable"].id, symbol: "MSFT", name: "Microsoft Corp",            quantity:  3,     price: 420.00, value: 1260.00, change24h:  0.7 },
      { accountId: byName["Sample Brokerage Taxable"].id, symbol: "VTI",  name: "Vanguard Total Market ETF", quantity:  2,     price: 245.00, value:  490.00, change24h:  0.5 },
      { accountId: byName["Sample Brokerage Taxable"].id, symbol: "CASH", name: "Buying Power",              quantity: -110.00, price:   1.00, value: -110.00, change24h:  0,  isCash: true },

      // ── Fictional Crypto Exchange ─────────────────────────────────────────
      { accountId: byName["Fictional Crypto Exchange"].id, symbol: "BTC", name: "Bitcoin",                   quantity: 0.025,  price: 98000.00, value: 2450.00, change24h:  1.2 },
      { accountId: byName["Fictional Crypto Exchange"].id, symbol: "ETH", name: "Ethereum",                  quantity: 0.8,    price: 2750.00, value: 2200.00, change24h:  0.8 },
      { accountId: byName["Fictional Crypto Exchange"].id, symbol: "SOL", name: "Solana",                    quantity: 3.0,    price:   66.67, value:  200.00, change24h:  2.3 },
      { accountId: byName["Fictional Crypto Exchange"].id, symbol: "CASH", name: "USD Balance",              quantity:  0.00,  price:   1.00, value:    0.00, change24h:  0,   isCash: true },

      // ── Demo BTC Wallet ───────────────────────────────────────────────────
      { accountId: byName["Demo BTC Wallet"].id,           symbol: "BTC", name: "Bitcoin",                   quantity: 0.02,   price: 98000.00, value: 1960.00, change24h:  1.2 },
    ],
  });
  console.log("   ✓ Holdings: 13");

  // ── Transactions ──────────────────────────────────────────────────────────
  const tx = (
    accountName: string,
    date:        string,
    merchant:    string,
    category:    TransactionCategory,
    amount:      number,
    pending      = false,
    description?: string,
  ) => ({
    accountId: byName[accountName].id,
    date:      new Date(date),
    merchant,
    category,
    amount,
    pending,
    description,
  });

  await prisma.transaction.createMany({
    data: [
      // ── Income ────────────────────────────────────────────────────────────
      tx("Demo Bank Checking", "2026-06-06", "Payroll Direct Deposit", TransactionCategory.Income,  3800.00),
      tx("Demo Bank Checking", "2026-05-23", "Payroll Direct Deposit", TransactionCategory.Income,  3800.00),

      // ── Interest ──────────────────────────────────────────────────────────
      tx("Demo Bank High Yield Savings", "2026-06-01", "Interest Credit", TransactionCategory.Interest,  30.62, false, "HYSA Interest — May 2026 (4.35% APY)"),
      tx("Demo Bank High Yield Savings", "2026-05-01", "Interest Credit", TransactionCategory.Interest,  28.90, false, "HYSA Interest — Apr 2026"),

      // ── Transfers ─────────────────────────────────────────────────────────
      tx("Demo Bank Checking",           "2026-06-03", "Transfer to Savings",    TransactionCategory.Transfer, -300.00),
      tx("Demo Bank High Yield Savings", "2026-06-03", "Transfer from Checking", TransactionCategory.Transfer,  300.00),

      // ── Groceries ─────────────────────────────────────────────────────────
      tx("Demo Bank Checking", "2026-06-07", "Fresh Market",    TransactionCategory.Groceries,  -95.40, true),
      tx("Demo Bank Checking", "2026-06-04", "Local Grocer",    TransactionCategory.Groceries,  -58.20),
      tx("Demo Bank Checking", "2026-05-30", "Fresh Market",    TransactionCategory.Groceries,  -81.15),
      tx("Demo Bank Checking", "2026-05-25", "Bulk Warehouse",  TransactionCategory.Groceries, -122.60),
      tx("Demo Bank Checking", "2026-05-18", "Local Grocer",    TransactionCategory.Groceries,  -47.85),

      // ── Dining ────────────────────────────────────────────────────────────
      tx("Demo Bank Checking", "2026-06-06", "The Burger Joint",  TransactionCategory.Dining,  -16.50),
      tx("Demo Bank Checking", "2026-06-03", "Taco Stand",        TransactionCategory.Dining,  -12.80),
      tx("Demo Bank Checking", "2026-05-29", "Coffee Corner",     TransactionCategory.Dining,   -5.75),
      tx("Demo Bank Checking", "2026-05-22", "Sushi Spot",        TransactionCategory.Dining,  -58.00),

      // ── Shopping ──────────────────────────────────────────────────────────
      tx("Demo Bank Checking", "2026-06-05", "Online Retailer",   TransactionCategory.Shopping, -74.99),
      tx("Demo Bank Checking", "2026-06-02", "Electronics Store", TransactionCategory.Shopping, -49.00),
      tx("Demo Bank Checking", "2026-05-28", "Online Retailer",   TransactionCategory.Shopping, -39.99),

      // ── Subscriptions ─────────────────────────────────────────────────────
      tx("Demo Bank Checking", "2026-06-01", "Streaming Service A", TransactionCategory.Subscriptions, -15.99),
      tx("Demo Bank Checking", "2026-06-01", "Streaming Service B", TransactionCategory.Subscriptions, -13.99),
      tx("Demo Bank Checking", "2026-06-01", "Cloud Storage",       TransactionCategory.Subscriptions,  -2.99),
      tx("Demo Bank Checking", "2026-05-28", "Music Service",       TransactionCategory.Subscriptions,  -9.99),

      // ── Utilities ─────────────────────────────────────────────────────────
      tx("Demo Bank Checking", "2026-06-01", "Electricity Co",   TransactionCategory.Utilities, -94.50),
      tx("Demo Bank Checking", "2026-05-28", "Mobile Carrier",   TransactionCategory.Utilities, -65.00),
      tx("Demo Bank Checking", "2026-05-25", "Internet Provider",TransactionCategory.Utilities, -59.99),

      // ── Credit Card charges ───────────────────────────────────────────────
      tx("Demo Credit Card", "2026-06-07", "Fresh Market",     TransactionCategory.Groceries,   -88.40, true),
      tx("Demo Credit Card", "2026-06-05", "Online Retailer",  TransactionCategory.Shopping,    -74.99),
      tx("Demo Credit Card", "2026-06-03", "Restaurant Downtown", TransactionCategory.Dining,  -142.00),
      tx("Demo Credit Card", "2026-06-01", "Hotel Stay",       TransactionCategory.Travel,     -285.00),
      tx("Demo Credit Card", "2026-05-28", "Bulk Warehouse",   TransactionCategory.Groceries,  -165.00),
      tx("Demo Credit Card", "2026-05-25", "Airline Ticket",   TransactionCategory.Travel,     -320.00),
      tx("Demo Credit Card", "2026-05-22", "Department Store", TransactionCategory.Shopping,    -92.00),
    ],
  });
  console.log("   ✓ Banking transactions: 32");

  // ── Investment / Crypto transactions ──────────────────────────────────────
  const itx = (
    accountName: string,
    date:        string,
    ticker:      string,
    category:    TransactionCategory,
    amount:      number,
    description: string,
  ) => ({
    accountId:   byName[accountName].id,
    date:        new Date(date),
    merchant:    ticker,
    category,
    amount,
    pending:     false,
    description,
  });

  await prisma.transaction.createMany({
    data: [
      itx("Sample Brokerage IRA",     "2026-05-20", "VOO",  TransactionCategory.Buy,    -1960.00, "Buy 4 shares @ $490.00"),
      itx("Sample Brokerage IRA",     "2026-04-15", "VOO",  TransactionCategory.Buy,    -2450.00, "Buy 5 shares @ $490.00"),
      itx("Sample Brokerage IRA",     "2026-03-10", "QQQ",  TransactionCategory.Buy,     -380.00, "Buy 1 share @ $380.00"),
      itx("Sample Brokerage Taxable", "2026-05-01", "AAPL", TransactionCategory.Buy,     -780.00, "Buy 4 shares @ $195.00"),
      itx("Sample Brokerage Taxable", "2026-04-10", "MSFT", TransactionCategory.Buy,    -1260.00, "Buy 3 shares @ $420.00"),
      itx("Sample Brokerage Taxable", "2026-03-15", "VTI",  TransactionCategory.Buy,     -490.00, "Buy 2 shares @ $245.00"),
      itx("Sample Brokerage Taxable", "2026-02-20", "AAPL", TransactionCategory.Buy,     -780.00, "Buy 4 shares @ $195.00"),
      itx("Fictional Crypto Exchange","2026-05-28", "BTC",  TransactionCategory.Buy,    -2450.00, "Buy 0.025 BTC @ $98,000"),
      itx("Fictional Crypto Exchange","2026-05-10", "ETH",  TransactionCategory.Buy,    -2200.00, "Buy 0.8 ETH @ $2,750"),
      itx("Fictional Crypto Exchange","2026-04-05", "SOL",  TransactionCategory.Buy,     -200.00, "Buy 3 SOL @ $66.67"),
      itx("Fictional Crypto Exchange","2026-02-01", "BTC",  TransactionCategory.Sell,   1200.00,  "Sell 0.013 BTC — partial exit"),
    ],
  });
  console.log("   ✓ Investment/crypto transactions: 11");

  // ── AI Advice ─────────────────────────────────────────────────────────────
  await prisma.aiAdvice.create({
    data: {
      workspaceId: janeWorkspace.id,
      agentId:     agent.id,
      summary:     "Good savings rate and low debt — focus on increasing investment contributions and reducing the credit card balance.",
      adviceText: `**Market Context (June 2026):** BTC near $98,000. S&P 500 steady. Interest rates elevated — HYSA at 4.35% APY remains attractive.

**Your Position:**
- Liquid cash: $3,450 (Demo Bank Checking) + $750 (Example CU) = **$4,200** — healthy 1-month cushion.
- Savings: $8,500 (Demo Bank HYSA at 4.35% APY) = **$8,500** — good emergency fund (~2 months expenses).
- Investments: Sample Brokerage IRA ($9,200) + Taxable ($3,200) = **$12,400** — well diversified in index funds.
- Crypto: Exchange ($4,850) + Demo Wallet ($1,950) = **$6,800** — ~28% of investable assets, manageable.
- Debt: Demo Credit Card **$3,200** at standard APR — moderate but worth addressing.
- Net worth: ~**$28,700** (assets $31,900 − debt $3,200).

**Suggestions:**
1. **Priority #1 — Pay down the credit card.** At typical APR this costs more than any savings interest earned. Target payoff within 3–4 months.
2. **Priority #2 — Max IRA contribution.** You're on a good path. Consider increasing monthly contributions to max the annual IRA limit.
3. **Crypto at 28%** of investable assets is within a reasonable range. No action needed unless it rises above 35%.
4. **HYSA is working** — keep the 3-month emergency fund target ($12,000) as the next milestone.
5. VOO and VTI positions are solid long-term holds. No changes needed.

**Risk Level: Low-Medium** — debt is manageable, savings are healthy, portfolio is well diversified.

**Play Ready: Yes** — credit card under control and cash reserves are adequate for small opportunistic moves.`,
      riskLevel:   "low",
      playReady:   true,
      generatedAt: new Date("2026-06-09T09:00:00Z"),
    },
  });
  console.log("   ✓ AiAdvice: 1");

  // ── WorkspaceSnapshots (365 days) ─────────────────────────────────────────
  const snapshots = buildHistory(janeWorkspace.id);
  await prisma.workspaceSnapshot.createMany({ data: snapshots });
  console.log(`   ✓ WorkspaceSnapshots: ${snapshots.length}`);

  // ════════════════════════════════════════════════════════════════════════════
  // ── JOHN DOE — medium-risk profile ─────────────────────────────────────────
  // ════════════════════════════════════════════════════════════════════════════

  // ── John's AiAgent ─────────────────────────────────────────────────────────
  const johnAgent = await prisma.aiAgent.create({
    data: { workspaceId: johnWorkspace.id, name: "John's Financial Agent" },
  });
  console.log(`   ✓ AiAgent: ${johnAgent.name}`);

  // ── John's CreditScore ─────────────────────────────────────────────────────
  await prisma.creditScore.create({
    data: {
      userId:     john.id,
      score:      680,
      source:     "manual",
      recordedAt: new Date("2026-06-01T10:00:00Z"),
    },
  });
  console.log("   ✓ CreditScore (John): 680 (manual)");

  // ── John's PlaidItems ──────────────────────────────────────────────────────
  const johnPlaidItems = await prisma.plaidItem.createManyAndReturn({
    data: [
      {
        userId:          john.id,
        plaidItemId:     "demo_item_beaconbank",
        institutionId:   "demo_ins_005",
        institutionName: "Beacon Bank",
        encryptedToken:  "[demo-placeholder-not-a-real-token]",
        status:          PlaidItemStatus.ACTIVE,
      },
      {
        userId:          john.id,
        plaidItemId:     "demo_item_alphabrokerage",
        institutionId:   "demo_ins_006",
        institutionName: "Alpha Brokerage",
        encryptedToken:  "[demo-placeholder-not-a-real-token]",
        status:          PlaidItemStatus.ACTIVE,
      },
      {
        userId:          john.id,
        plaidItemId:     "demo_item_alphacrypto",
        institutionId:   "demo_ins_007",
        institutionName: "Alpha Crypto Exchange",
        encryptedToken:  "[demo-placeholder-not-a-real-token]",
        status:          PlaidItemStatus.ACTIVE,
      },
    ],
  });
  const johnItemBy = Object.fromEntries(
    johnPlaidItems.map((p) => [(p as { institutionName: string }).institutionName, p])
  ) as Record<string, typeof johnPlaidItems[0]>;
  console.log(`   ✓ PlaidItems (John): ${johnPlaidItems.length}`);

  // ── John's Accounts ────────────────────────────────────────────────────────
  const johnAccounts = await prisma.account.createManyAndReturn({
    data: [
      // ── Beacon Bank ──────────────────────────────────────────────────────
      {
        workspaceId: johnWorkspace.id, ownerId: john.id,
        name: "Beacon Bank Checking",    type: AccountType.checking,
        institution: "Beacon Bank",      balance: 2100.00, availableBalance: 2100.00,
        currency: "USD", lastUpdated: new Date("2026-06-09T10:00:00Z"),
        plaidItemDbId: johnItemBy["Beacon Bank"].id,
      },
      {
        workspaceId: johnWorkspace.id, ownerId: john.id,
        name: "Beacon Bank Savings",     type: AccountType.savings,
        institution: "Beacon Bank",      balance: 5500.00, availableBalance: 5500.00,
        currency: "USD", lastUpdated: new Date("2026-06-09T10:00:00Z"),
        plaidItemDbId: johnItemBy["Beacon Bank"].id,
      },
      {
        workspaceId: johnWorkspace.id, ownerId: john.id,
        name: "Beacon Credit Card",      type: AccountType.debt,
        institution: "Beacon Bank",      balance: 5800.00, creditLimit: 15000,
        currency: "USD", lastUpdated: new Date("2026-06-09T10:00:00Z"),
        plaidItemDbId: johnItemBy["Beacon Bank"].id,
      },
      {
        workspaceId: johnWorkspace.id, ownerId: john.id,
        name: "Beacon Auto Loan",        type: AccountType.debt,
        institution: "Beacon Bank",      balance: 11200.00,
        currency: "USD", lastUpdated: new Date("2026-06-09T10:00:00Z"),
        plaidItemDbId: johnItemBy["Beacon Bank"].id,
      },
      // ── Alpha Brokerage ───────────────────────────────────────────────────
      {
        workspaceId: johnWorkspace.id, ownerId: john.id,
        name: "Alpha Brokerage 401k",    type: AccountType.investment,
        institution: "Alpha Brokerage",  balance: 18200.00,
        currency: "USD", lastUpdated: new Date("2026-06-09T10:00:00Z"),
        plaidItemDbId: johnItemBy["Alpha Brokerage"].id,
      },
      // ── Alpha Crypto Exchange ─────────────────────────────────────────────
      {
        workspaceId: johnWorkspace.id, ownerId: john.id,
        name: "Alpha Crypto Exchange",   type: AccountType.crypto,
        institution: "Alpha Crypto Exchange", balance: 7400.00,
        currency: "USD", lastUpdated: new Date("2026-06-09T10:00:00Z"),
        plaidItemDbId: johnItemBy["Alpha Crypto Exchange"].id,
      },
    ],
  });
  const johnByName: Record<string, typeof johnAccounts[0]> = Object.fromEntries(
    johnAccounts.map((a) => [a.name, a])
  );
  console.log(`   ✓ Accounts (John): ${johnAccounts.length}`);

  // ── John's Holdings ────────────────────────────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (prisma.holding as any).createMany({
    data: [
      // ── Alpha Brokerage 401k — tech-concentrated ──────────────────────────
      { accountId: johnByName["Alpha Brokerage 401k"].id,   symbol: "NVDA", name: "NVIDIA Corp",           quantity: 5,      price: 1100.00, value:  5500.00, change24h:  2.1 },
      { accountId: johnByName["Alpha Brokerage 401k"].id,   symbol: "TSLA", name: "Tesla Inc",              quantity: 10,     price:  280.00, value:  2800.00, change24h: -0.9 },
      { accountId: johnByName["Alpha Brokerage 401k"].id,   symbol: "VOO",  name: "Vanguard S&P 500 ETF",   quantity: 20,     price:  490.00, value:  9800.00, change24h:  0.6 },
      { accountId: johnByName["Alpha Brokerage 401k"].id,   symbol: "CASH", name: "Uninvested Cash",        quantity: 100,    price:    1.00, value:   100.00, change24h:  0,   isCash: true },
      // ── Alpha Crypto Exchange — medium-risk mix ───────────────────────────
      { accountId: johnByName["Alpha Crypto Exchange"].id,  symbol: "BTC",  name: "Bitcoin",                quantity: 0.04,   price: 98000.00, value: 3920.00, change24h:  1.2 },
      { accountId: johnByName["Alpha Crypto Exchange"].id,  symbol: "ETH",  name: "Ethereum",               quantity: 1.2,    price:  2750.00, value: 3300.00, change24h:  0.8 },
      { accountId: johnByName["Alpha Crypto Exchange"].id,  symbol: "DOGE", name: "Dogecoin",               quantity: 1000,   price:     0.18, value:  180.00, change24h:  5.4 },
      { accountId: johnByName["Alpha Crypto Exchange"].id,  symbol: "CASH", name: "USD Balance",            quantity: 0,      price:     1.00, value:    0.00, change24h:  0,   isCash: true },
    ],
  });
  console.log("   ✓ Holdings (John): 8");

  // ── John's Transactions ────────────────────────────────────────────────────
  const jtx = (
    accountName: string,
    date:        string,
    merchant:    string,
    category:    TransactionCategory,
    amount:      number,
    pending      = false,
    description?: string,
  ) => ({
    accountId: johnByName[accountName].id,
    date:      new Date(date),
    merchant,
    category,
    amount,
    pending,
    description,
  });

  await prisma.transaction.createMany({
    data: [
      // ── Income ────────────────────────────────────────────────────────────
      jtx("Beacon Bank Checking", "2026-06-06", "Payroll Direct Deposit", TransactionCategory.Income,   4200.00),
      jtx("Beacon Bank Checking", "2026-05-23", "Payroll Direct Deposit", TransactionCategory.Income,   4200.00),
      // ── Interest ──────────────────────────────────────────────────────────
      jtx("Beacon Bank Savings",  "2026-06-01", "Interest Credit",        TransactionCategory.Interest,   18.48, false, "Savings Interest — May 2026"),
      // ── Transfers ─────────────────────────────────────────────────────────
      jtx("Beacon Bank Checking", "2026-06-03", "Transfer to Savings",    TransactionCategory.Transfer,  -200.00),
      jtx("Beacon Bank Savings",  "2026-06-03", "Transfer from Checking", TransactionCategory.Transfer,   200.00),
      // ── Groceries ─────────────────────────────────────────────────────────
      jtx("Beacon Bank Checking", "2026-06-07", "Neighborhood Market",    TransactionCategory.Groceries,  -88.50, true),
      jtx("Beacon Bank Checking", "2026-06-04", "Wholesale Club",         TransactionCategory.Groceries, -134.20),
      jtx("Beacon Bank Checking", "2026-05-28", "Neighborhood Market",    TransactionCategory.Groceries,  -72.10),
      // ── Dining ────────────────────────────────────────────────────────────
      jtx("Beacon Bank Checking", "2026-06-05", "Sports Bar & Grill",     TransactionCategory.Dining,     -48.00),
      jtx("Beacon Bank Checking", "2026-06-02", "Fast Food Express",      TransactionCategory.Dining,     -14.50),
      jtx("Beacon Bank Checking", "2026-05-29", "Pizza Palace",           TransactionCategory.Dining,     -32.00),
      // ── Subscriptions ─────────────────────────────────────────────────────
      jtx("Beacon Bank Checking", "2026-06-01", "Gaming Subscription",    TransactionCategory.Subscriptions, -14.99),
      jtx("Beacon Bank Checking", "2026-06-01", "Streaming Service",      TransactionCategory.Subscriptions, -15.99),
      // ── Utilities ─────────────────────────────────────────────────────────
      jtx("Beacon Bank Checking", "2026-06-01", "Electric Co",            TransactionCategory.Utilities,  -112.00),
      jtx("Beacon Bank Checking", "2026-05-28", "Mobile Carrier",         TransactionCategory.Utilities,   -75.00),
      jtx("Beacon Bank Checking", "2026-05-25", "Gas & Electric",         TransactionCategory.Utilities,   -68.00),
      // ── Auto loan payments ─────────────────────────────────────────────────
      jtx("Beacon Bank Checking", "2026-06-05", "Auto Loan Payment",      TransactionCategory.Payment,    -380.00),
      jtx("Beacon Bank Checking", "2026-05-05", "Auto Loan Payment",      TransactionCategory.Payment,    -380.00),
      // ── Credit card charges ───────────────────────────────────────────────
      jtx("Beacon Credit Card",   "2026-06-07", "Electronics Superstore", TransactionCategory.Shopping,   -349.00, true),
      jtx("Beacon Credit Card",   "2026-06-05", "Sporting Goods Outlet",  TransactionCategory.Shopping,   -185.00),
      jtx("Beacon Credit Card",   "2026-06-03", "Steakhouse Downtown",    TransactionCategory.Dining,     -118.00),
      jtx("Beacon Credit Card",   "2026-06-01", "Weekend Trip Hotel",     TransactionCategory.Travel,     -420.00),
      jtx("Beacon Credit Card",   "2026-05-28", "Online Retailer",        TransactionCategory.Shopping,    -89.99),
      jtx("Beacon Credit Card",   "2026-05-25", "Concert Tickets",        TransactionCategory.Shopping,   -210.00),
    ],
  });
  console.log("   ✓ Banking transactions (John): 24");

  // ── John's Investment/Crypto transactions ──────────────────────────────────
  const jitx = (
    accountName: string,
    date:        string,
    ticker:      string,
    category:    TransactionCategory,
    amount:      number,
    description: string,
  ) => ({
    accountId:   johnByName[accountName].id,
    date:        new Date(date),
    merchant:    ticker,
    category,
    amount,
    pending:     false,
    description,
  });

  await prisma.transaction.createMany({
    data: [
      jitx("Alpha Brokerage 401k",  "2026-05-20", "NVDA", TransactionCategory.Buy,  -1100.00, "Buy 1 share @ $1,100.00"),
      jitx("Alpha Brokerage 401k",  "2026-04-15", "TSLA", TransactionCategory.Buy,  -2800.00, "Buy 10 shares @ $280.00"),
      jitx("Alpha Brokerage 401k",  "2026-03-10", "VOO",  TransactionCategory.Buy,  -4900.00, "Buy 10 shares @ $490.00"),
      jitx("Alpha Crypto Exchange", "2026-05-28", "BTC",  TransactionCategory.Buy,  -3920.00, "Buy 0.04 BTC @ $98,000"),
      jitx("Alpha Crypto Exchange", "2026-05-10", "ETH",  TransactionCategory.Buy,  -3300.00, "Buy 1.2 ETH @ $2,750"),
      jitx("Alpha Crypto Exchange", "2026-04-20", "DOGE", TransactionCategory.Buy,   -180.00, "Buy 1,000 DOGE @ $0.18"),
      jitx("Alpha Crypto Exchange", "2026-02-14", "ETH",  TransactionCategory.Sell,  1500.00,  "Sell 0.55 ETH — partial profit-taking"),
    ],
  });
  console.log("   ✓ Investment/crypto transactions (John): 7");

  // ── John's AI Advice ───────────────────────────────────────────────────────
  await prisma.aiAdvice.create({
    data: {
      workspaceId: johnWorkspace.id,
      agentId:     johnAgent.id,
      summary:     "High debt load and thin cash reserves signal 'hold' — eliminate the credit card balance before deploying any new capital.",
      adviceText: `**Market Context (June 2026):** BTC near $98,000. S&P 500 steady. Interest rates elevated.

**Your Position:**
- Liquid cash: $2,100 (Beacon Bank Checking) — roughly 0.5 months expenses. Thin.
- Savings: $5,500 — covers about 1 month expenses. Below the recommended 3-month cushion ($12,000+).
- Investments: Alpha Brokerage 401k $18,200 — tech-heavy (NVDA + TSLA = 46%). High concentration risk.
- Crypto: $7,400 — ~22% of investable assets. High side of medium-risk band.
- Debt: Credit card $5,800 at likely 20%+ APR + auto loan $11,200 at ~6% = **$17,000 total**.
- Net worth: ~**$16,200** (assets $33,200 − debt $17,000).

**Suggestions:**
1. **Priority #1 — Pay down the credit card.** At 20%+ APR, this is your most expensive money. Redirect all surplus cash here until it's gone.
2. **Priority #2 — Build the emergency fund.** $5,500 is not enough cushion. Target $12,000+ before adding new investment capital.
3. **NVDA + TSLA = 46% of your 401k.** Rebalance toward VOO or a diversified ETF over time. Don't let two names dominate.
4. **Crypto at 22% of investable assets** is within the medium-risk range, but adding more while carrying high-APR debt is not advised.
5. **Auto loan at ~6%** is manageable — prioritize the credit card over accelerated auto payoff.

**Risk Level: Medium** — good income, growing investments, but debt load is limiting flexibility.

**Play Ready: No** — credit card balance and thin cash buffer rule out discretionary capital deployment right now.`,
      riskLevel:   "medium",
      playReady:   false,
      generatedAt: new Date("2026-06-09T09:00:00Z"),
    },
  });
  console.log("   ✓ AiAdvice (John): 1");

  // ── John's WorkspaceSnapshots (365 days) ───────────────────────────────────
  const johnSnapshots = buildJohnHistory(johnWorkspace.id);
  await prisma.workspaceSnapshot.createMany({ data: johnSnapshots });
  console.log(`   ✓ WorkspaceSnapshots (John): ${johnSnapshots.length}`);

  // ── Audit log entry for seed ───────────────────────────────────────────────
  await prisma.auditLog.create({
    data: {
      userId:      jane.id,
      workspaceId: janeWorkspace.id,
      action:      "SEED",
      metadata:    { note: "Initial database seed — demo data only" },
    },
  });

  console.log("\n✅  Seed complete.");
  console.log("── Jane Smith ─────────────────────────────────────────────────────────────");
  console.log(`   Workspace:  ${janeWorkspace.name} (id: ${janeWorkspace.id})`);
  console.log("   Net worth:  ~$28,700 (assets $31,900 − debt $3,200)");
  console.log("   Cash:       $4,200 checking | $8,500 savings");
  console.log("   Debt:       Demo Credit Card $3,200");
  console.log("   Crypto:     ~28% of investable assets");
  console.log("   FICO:       720 | Risk level: low | Play ready: YES");
  console.log("── John Doe ───────────────────────────────────────────────────────────────");
  console.log(`   Workspace:  ${johnWorkspace.name} (id: ${johnWorkspace.id})`);
  console.log("   Net worth:  ~$16,200 (assets $33,200 − debt $17,000)");
  console.log("   Cash:       $2,100 checking | $5,500 savings");
  console.log("   Debt:       Beacon Credit Card $5,800 + Auto Loan $11,200");
  console.log("   Crypto:     ~22% of investable assets");
  console.log("   FICO:       680 | Risk level: medium | Play ready: NO");
  console.log("── Shared ─────────────────────────────────────────────────────────────────");
  console.log(`   Workspace:  ${sharedWorkspace.name} (id: ${sharedWorkspace.id})`);
  console.log("\n🔑  Demo login credentials (local dev only — change before any real deployment):");
  console.log(`   jane@example.com   (@janesmith)  /  ${JANE_PASSWORD}`);
  console.log(`   john@example.com   (@johndoe)    /  ${JANE_PASSWORD}`);
  console.log(`   admin@example.com  (@admin)       /  ${ADMIN_PASSWORD}`);
}

main()
  .catch((e) => {
    console.error("❌  Seed failed:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
