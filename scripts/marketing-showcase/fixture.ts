/**
 * scripts/marketing-showcase/fixture.ts — the deterministic, SYNTHETIC demo
 * household behind every marketing product capture (site/public/showcase/).
 *
 * Nothing here is read from a database, a provider or a real account: every
 * figure is generated from a fixed seed and a fixed calendar, so re-running the
 * capture reproduces the same pixels. Institution and merchant names are
 * generic on purpose — no real bank, card, exchange or wallet address appears.
 */
import type { Snapshot } from "@/types";

/** The demo's "today". Fixed so the captures never drift with the wall clock. */
export const DEMO_TODAY = "2026-10-15";
export const DEMO_CURRENCY = "USD";

/** mulberry32 — a tiny seeded PRNG, so the noise is identical on every run. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DAY = 86_400_000;
export const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export const addDays = (iso: string, n: number) => isoDay(Date.parse(`${iso}T00:00:00Z`) + n * DAY);
const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * 400 daily Personal Space snapshots ending DEMO_TODAY: a salaried household
 * with checking + savings, a brokerage and retirement account, a small crypto
 * position, a home, a mortgage and a credit card. Markets wobble, cash follows
 * a semi-monthly payday rhythm, the mortgage amortises, the home is revalued
 * twice. The engine (computeWealthTimeMachine) derives everything else.
 */
export function demoSnapshots(): Snapshot[] {
  const rnd = seeded(41);
  const days = 400;
  const start = addDays(DEMO_TODAY, -(days - 1));
  const out: Snapshot[] = [];
  let market = 1;          // brokerage + retirement index
  let cryptoIdx = 1;
  let mortgage = 386_400;
  for (let i = 0; i < days; i++) {
    const date = addDays(start, i);
    const d = new Date(`${date}T00:00:00Z`);
    const dom = d.getUTCDate();
    market *= 1 + (rnd() - 0.47) * 0.012;
    cryptoIdx *= 1 + (rnd() - 0.48) * 0.035;
    if (dom === 1) mortgage -= 690;
    // Cash: rises on the 1st and 15th (payday), drains through the month.
    const phase = dom < 15 ? dom : dom - 14;
    const checking = 9_800 + i * 9 - phase * 120 + rnd() * 520;
    const savings = 24_500 + Math.floor(i / 30) * 650;
    const investments = 168_000 * market + i * 62;      // + monthly contributions
    const crypto = 14_200 * cryptoIdx;
    const home = i < 140 ? 545_000 : i < 320 ? 552_000 : 561_000;
    const card = 1_400 + phase * 40 + rnd() * 260;
    const totalCash = round2(checking);
    const totalSavings = round2(savings);
    const totalInvestments = round2(investments);
    const totalCrypto = round2(crypto);
    const totalDebt = round2(mortgage + card);
    const totalAssets = round2(totalCash + totalSavings + totalInvestments + totalCrypto + home);
    out.push({
      date,
      netWorth: round2(totalAssets - totalDebt),
      totalAssets,
      totalDebt,
      totalCash,
      totalSavings,
      totalInvestments,
      totalCrypto,
      total: round2(totalInvestments + totalCrypto),
      cashOnHand: round2(totalCash + totalSavings),
      netLiquid: round2(totalCash + totalSavings - card),
      isEstimated: false,
      currency: DEMO_CURRENCY,
    } as Snapshot);
  }
  return out;
}

/* ── Cash Flow: 6 months of transactions on a checking account + a card ───── */

export const DEMO_ACCOUNTS = [
  { id: "demo-chk", name: "Everyday Checking", type: "checking", currency: DEMO_CURRENCY },
  { id: "demo-sav", name: "High-Yield Savings", type: "savings", currency: DEMO_CURRENCY },
  { id: "demo-cc", name: "Rewards Card", type: "debt", currency: DEMO_CURRENCY },
  { id: "demo-mtg", name: "Home Mortgage", type: "debt", currency: DEMO_CURRENCY },
];

type Row = { id: string; date: string; amount: number; accountId: string; category: string; merchant: string; flowType: string; [k: string]: unknown };

/**
 * Generic, invented merchants only. Two paydays a month, a mortgage, utilities,
 * subscriptions, groceries and dining on the card, a monthly card payment and a
 * savings transfer (both internal moves, never spending).
 */
export function demoTransactions(): Row[] {
  const rnd = seeded(7);
  const rows: Row[] = [];
  let n = 0;
  // `extra` carries the read-model fields a synced row arrives with (income
  // class, the internal move's counterparty), as the classifier would set them.
  const add = (date: string, amount: number, accountId: string, category: string, merchant: string, flowType: string, extra: Record<string, unknown> = {}) =>
    rows.push({ id: `demo-tx-${++n}`, date, amount: Math.round(amount * 100) / 100, accountId, category, merchant, flowType, ...extra });
  const start = addDays(DEMO_TODAY, -183);
  for (let i = 0; i <= 183; i++) {
    const date = addDays(start, i);
    const d = new Date(`${date}T00:00:00Z`);
    const dom = d.getUTCDate();
    const dow = d.getUTCDay();
    if (dom === 1 || dom === 16) add(date, 4_310, "demo-chk", "Income", "Northwind Labs Payroll", "INCOME", { incomeClass: "EARNED_INCOME", incomeSubtype: "SALARY" });
    if (dom === 2) add(date, -2_480, "demo-chk", "Payment", "Harbor Home Loans", "DEBT_PAYMENT", { counterpartyAccountId: "demo-mtg" });
    if (dom === 5) add(date, -1_000, "demo-chk", "Transfer", "Transfer to High-Yield Savings", "TRANSFER", { counterpartyAccountId: "demo-sav" });
    if (dom === 8) add(date, -138 - rnd() * 40, "demo-chk", "Utilities", "City Power & Water", "SPENDING");
    if (dom === 11) add(date, -79.99, "demo-chk", "Utilities", "Metro Fiber Internet", "SPENDING");
    if (dom === 18) add(date, -1_650 - rnd() * 500, "demo-chk", "Payment", "Rewards Card Payment", "DEBT_PAYMENT", { counterpartyAccountId: "demo-cc" });
    if (dom === 21) add(date, -15.99, "demo-cc", "Subscriptions", "StreamBox", "SPENDING");
    if (dom === 24) add(date, -64, "demo-cc", "Subscriptions", "Peak Climbing Gym", "SPENDING");
    if (dom === 28) add(date, 6.12, "demo-sav", "Interest", "Savings Interest", "INCOME", { incomeClass: "INTEREST_INCOME", incomeSubtype: "DEPOSIT_INTEREST" });
    if (dow === 6 || dow === 2) add(date, -(72 + rnd() * 95), "demo-cc", "Groceries", dow === 6 ? "Green Basket Market" : "Corner Grocer", "SPENDING");
    if (rnd() < 0.38) add(date, -(14 + rnd() * 62), "demo-cc", "Dining", ["Juniper Café", "Saffron Kitchen", "Harbor Noodle Bar", "Little Ember Pizza"][Math.floor(rnd() * 4)], "SPENDING");
    if (rnd() < 0.16) add(date, -(32 + rnd() * 30), "demo-cc", "Other", "Fuel Stop", "SPENDING");
    if (rnd() < 0.09) add(date, -(40 + rnd() * 180), "demo-cc", "Shopping", ["Oak & Thread", "Brightline Home", "Paper Lantern Books"][Math.floor(rnd() * 3)], "SPENDING");
    if (i === 120) add(date, -612, "demo-cc", "Travel", "Coastline Air", "SPENDING");
    if (i === 132) add(date, -380, "demo-cc", "Travel", "Seaside Inn", "SPENDING");
  }
  return rows;
}

/* ── Connections: two bank links, a watch-only wallet, a home ─────────────── */

export function demoConnections() {
  const synced = `${DEMO_TODAY}T06:12:00.000Z`;
  const conn = (id: string, provider: "PLAID" | "WALLET", institution: string) => ({
    id, provider, institution, state: "ready" as const, lastSyncedAt: synced,
    errorCode: null, importedCount: null, historyBuild: null,
    deferredReason: null, investments: null,
  });
  return {
    status: {
      building: false,
      connections: [
        conn("demo-conn-bank", "PLAID", "Harborview Bank"),
        conn("demo-conn-broker", "PLAID", "Summit Investments"),
        conn("demo-conn-card", "PLAID", "Meridian Rewards Card"),
        conn("demo-conn-btc", "WALLET", "Bitcoin savings wallet"),
      ],
    },
    accountsByConnectionId: {
      "demo-conn-bank": [
        { id: "a1", name: "Everyday Checking", type: "depository", subtype: "checking", mask: "0000" },
        { id: "a2", name: "High-Yield Savings", type: "depository", subtype: "savings", mask: "0000" },
        { id: "a3", name: "Home Mortgage", type: "loan", subtype: "mortgage", mask: "0000" },
      ],
      "demo-conn-broker": [
        { id: "a4", name: "Brokerage", type: "investment", subtype: "brokerage", mask: "0000" },
        { id: "a5", name: "Retirement (401k)", type: "investment", subtype: "401k", mask: "0000" },
      ],
      "demo-conn-card": [{ id: "a6", name: "Rewards Card", type: "credit", subtype: "credit card", mask: "0000" }],
      "demo-conn-btc": [{ id: "a7", name: "Bitcoin", type: "crypto", chain: "BITCOIN", publicAddress: null }],
    },
    manualAssets: [{
      id: "demo-home", name: "Home", value: 561_000, currency: DEMO_CURRENCY,
      valuedAsOfISO: addDays(DEMO_TODAY, -80), acquisitionDateISO: "2019-06-14",
      purchasePrice: 468_000, purchaseCurrency: DEMO_CURRENCY,
      spaces: [{ id: "demo-space", name: "Personal" }], activity: [],
    }],
  };
}
