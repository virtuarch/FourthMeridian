/**
 * lib/mock-data.ts
 *
 * Static fixtures for unit tests, Storybook, and component development.
 * All data is entirely fictional — no real names, balances, wallet addresses,
 * or institution identifiers. Matches the Jane Smith demo profile from seed.ts.
 */

import { Account, Holding, Snapshot, AiAdvice, Transaction } from '@/types';

// ── Accounts ─────────────────────────────────────────────────────────────────
export const mockAccounts: Account[] = [
  // Demo Bank
  { id: 'db-chk',  name: 'Demo Bank Checking',          type: 'checking',   institution: 'Demo Bank',               balance:  3450.00, currency: 'USD', lastUpdated: '2026-06-09T10:00:00Z' },
  { id: 'db-hys',  name: 'Demo Bank High Yield Savings', type: 'savings',    institution: 'Demo Bank',               balance:  8500.00, currency: 'USD', lastUpdated: '2026-06-09T10:00:00Z' },
  // Example Credit Union
  { id: 'ecu-chk', name: 'Example CU Checking',          type: 'checking',   institution: 'Example Credit Union',    balance:   750.00, currency: 'USD', lastUpdated: '2026-06-09T10:00:00Z' },
  { id: 'ecu-cc',  name: 'Demo Credit Card',             type: 'debt',       institution: 'Example Credit Union',    balance:  3200.00, currency: 'USD', lastUpdated: '2026-06-09T10:00:00Z' },
  // Sample Brokerage
  { id: 'sb-ira',  name: 'Sample Brokerage IRA',         type: 'investment', institution: 'Sample Brokerage',        balance:  9200.00, currency: 'USD', lastUpdated: '2026-06-09T10:00:00Z' },
  { id: 'sb-tax',  name: 'Sample Brokerage Taxable',     type: 'investment', institution: 'Sample Brokerage',        balance:  3200.00, currency: 'USD', lastUpdated: '2026-06-09T10:00:00Z' },
  // Fictional Crypto
  { id: 'fce',     name: 'Fictional Crypto Exchange',    type: 'crypto',     institution: 'Fictional Crypto Exchange', balance: 4850.00, currency: 'USD', lastUpdated: '2026-06-09T10:00:00Z' },
  // Demo wallet — fictional/invalid address, not a real wallet
  { id: 'w-btc',   name: 'Demo BTC Wallet',              type: 'crypto',     institution: 'Self-custodied',          balance:  1950.00, currency: 'USD', lastUpdated: '2026-06-09T10:05:00Z',
    walletAddress: 'bc1demo000000000000000000000000000000000000', walletChain: 'BTC', nativeBalance: 0.02, syncStatus: 'synced' },
];

// ── Holdings ─────────────────────────────────────────────────────────────────
export const mockHoldings: Holding[] = [
  // Sample Brokerage IRA
  { id: 'h1', accountId: 'sb-ira',  symbol: 'VOO',  name: 'Vanguard S&P 500 ETF',     quantity: 18,    price: 490.00,    value: 8820.00, change24h:  0.6, isCash: false },
  { id: 'h2', accountId: 'sb-ira',  symbol: 'QQQ',  name: 'Invesco QQQ Trust',         quantity:  1,    price: 380.00,    value:  380.00, change24h:  1.1, isCash: false },
  // Sample Brokerage Taxable
  { id: 'h3', accountId: 'sb-tax',  symbol: 'AAPL', name: 'Apple Inc',                 quantity:  8,    price: 195.00,    value: 1560.00, change24h:  0.4, isCash: false },
  { id: 'h4', accountId: 'sb-tax',  symbol: 'MSFT', name: 'Microsoft Corp',            quantity:  3,    price: 420.00,    value: 1260.00, change24h:  0.7, isCash: false },
  { id: 'h5', accountId: 'sb-tax',  symbol: 'VTI',  name: 'Vanguard Total Market ETF', quantity:  2,    price: 245.00,    value:  490.00, change24h:  0.5, isCash: false },
  // Fictional Crypto Exchange
  { id: 'h6', accountId: 'fce',     symbol: 'BTC',  name: 'Bitcoin',                   quantity: 0.025, price: 98000.00,  value: 2450.00, change24h:  1.2, isCash: false },
  { id: 'h7', accountId: 'fce',     symbol: 'ETH',  name: 'Ethereum',                  quantity: 0.8,   price: 2750.00,   value: 2200.00, change24h:  0.8, isCash: false },
  { id: 'h8', accountId: 'fce',     symbol: 'SOL',  name: 'Solana',                    quantity: 3.0,   price:   66.67,   value:  200.00, change24h:  2.3, isCash: false },
  // Demo BTC Wallet
  { id: 'h9', accountId: 'w-btc',   symbol: 'BTC',  name: 'Bitcoin',                   quantity: 0.02,  price: 98000.00,  value: 1960.00, change24h:  1.2, isCash: false },
];

// ── Transactions ─────────────────────────────────────────────────────────────
export const mockTransactions: Transaction[] = [
  // Income
  { id: 't01', accountId: 'db-chk', date: '2026-06-06', merchant: 'Payroll Direct Deposit', category: 'Income',        amount:  3800.00, pending: false },
  { id: 't02', accountId: 'db-chk', date: '2026-05-23', merchant: 'Payroll Direct Deposit', category: 'Income',        amount:  3800.00, pending: false },
  // Interest
  { id: 't03', accountId: 'db-hys', date: '2026-06-01', merchant: 'Interest Credit',        category: 'Interest',      amount:    30.62, pending: false, description: 'HYSA Interest — May 2026' },
  // Transfers
  { id: 't04', accountId: 'db-chk', date: '2026-06-03', merchant: 'Transfer to Savings',    category: 'Transfer',      amount:  -300.00, pending: false },
  { id: 't05', accountId: 'db-hys', date: '2026-06-03', merchant: 'Transfer from Checking', category: 'Transfer',      amount:   300.00, pending: false },
  // Groceries
  { id: 't06', accountId: 'db-chk', date: '2026-06-07', merchant: 'Fresh Market',           category: 'Groceries',     amount:   -95.40, pending: true  },
  { id: 't07', accountId: 'db-chk', date: '2026-06-04', merchant: 'Local Grocer',           category: 'Groceries',     amount:   -58.20, pending: false },
  { id: 't08', accountId: 'ecu-cc', date: '2026-06-05', merchant: 'Bulk Warehouse',         category: 'Groceries',     amount:  -165.00, pending: false },
  // Dining
  { id: 't09', accountId: 'db-chk', date: '2026-06-06', merchant: 'The Burger Joint',       category: 'Dining',        amount:   -16.50, pending: false },
  { id: 't10', accountId: 'ecu-cc', date: '2026-06-03', merchant: 'Restaurant Downtown',    category: 'Dining',        amount:  -142.00, pending: false },
  // Shopping
  { id: 't11', accountId: 'db-chk', date: '2026-06-05', merchant: 'Online Retailer',        category: 'Shopping',      amount:   -74.99, pending: false },
  { id: 't12', accountId: 'ecu-cc', date: '2026-06-05', merchant: 'Online Retailer',        category: 'Shopping',      amount:   -74.99, pending: false },
  // Travel
  { id: 't13', accountId: 'ecu-cc', date: '2026-06-01', merchant: 'Hotel Stay',             category: 'Travel',        amount:  -285.00, pending: false },
  { id: 't14', accountId: 'ecu-cc', date: '2026-05-25', merchant: 'Airline Ticket',         category: 'Travel',        amount:  -320.00, pending: false },
  // Subscriptions
  { id: 't15', accountId: 'db-chk', date: '2026-06-01', merchant: 'Streaming Service A',    category: 'Subscriptions', amount:   -15.99, pending: false },
  { id: 't16', accountId: 'db-chk', date: '2026-06-01', merchant: 'Streaming Service B',    category: 'Subscriptions', amount:   -13.99, pending: false },
  // Utilities
  { id: 't17', accountId: 'db-chk', date: '2026-06-01', merchant: 'Electricity Co',         category: 'Utilities',     amount:   -94.50, pending: false },
  { id: 't18', accountId: 'db-chk', date: '2026-05-28', merchant: 'Mobile Carrier',         category: 'Utilities',     amount:   -65.00, pending: false },
];

// ── Portfolio history (365 days) ──────────────────────────────────────────────
function seededRand(seed: number) {
  const x = Math.sin(seed + 1) * 10000;
  return x - Math.floor(x);
}

export const mockPortfolioHistory = Array.from({ length: 365 }, (_, i) => {
  const date = new Date('2026-06-09');
  date.setDate(date.getDate() - (364 - i));
  const t = i / 364;

  const stocks  = Math.round(8000  + t * 4400 + Math.sin(i * 0.09) * 500 + (seededRand(i)      - 0.5) * 400);
  const crypto  = Math.round(4000  + t * 2800 + Math.sin(i * 0.11) * 1200 + (seededRand(i + 99) - 0.42) * 800);
  const cash    = Math.round(3800  + Math.sin(i * 0.08) * 600              + (seededRand(i + 33) - 0.5) * 400);
  const savings = Math.round(5500  + t * 3000                              + (seededRand(i + 77) - 0.5) * 100);
  const debt    = Math.round(5200  - t * 2000 + Math.sin(i * 0.05) * 300  + (seededRand(i + 55) - 0.5) * 200);

  return {
    date:    date.toISOString().split('T')[0],
    stocks:  Math.max(stocks,  0),
    crypto:  Math.max(crypto,  0),
    total:   Math.max(stocks + crypto, 0),
    cash:    Math.max(cash,    0),
    savings: Math.max(savings, 0),
    debt:    Math.abs(debt),
  };
});

// ── Snapshots (last 30 days) ───────────────────────────────────────────────────
export const mockSnapshots: Snapshot[] = mockPortfolioHistory.slice(-30).map((h) => ({
  date:             h.date,
  netWorth:         h.stocks + h.crypto + h.cash + h.savings - h.debt,
  totalAssets:      h.stocks + h.crypto + h.cash + h.savings,
  totalDebt:        h.debt,
  totalCash:        h.cash,
  totalSavings:     h.savings,
  totalInvestments: h.stocks,
  totalCrypto:      h.crypto,
  cashOnHand:       Math.max(h.cash - 6000, 0),
}));

// ── AI Advice ─────────────────────────────────────────────────────────────────
export const mockAdvice: AiAdvice = {
  id: 'a1',
  summary: 'Good savings rate and low debt — focus on increasing investment contributions and reducing the credit card balance.',
  adviceText: `**Market Context:** Markets are steady. BTC near $98,000. S&P 500 index funds performing well.

**Your Position:**
- Liquid cash: $3,450 (Demo Bank Checking) + $750 (Example CU) = **$4,200**
- Savings: $8,500 (Demo Bank HYSA at ~4.35% APY) — solid emergency fund
- Investments: $12,400 across IRA and taxable brokerage — well diversified in index funds
- Crypto: $6,800 (~28% of investable assets) — within reasonable range
- Debt: Demo Credit Card **$3,200** — moderate, worth prioritizing

**Suggestions:**
1. Pay down the credit card balance over the next 3–4 months.
2. Consider increasing IRA contributions toward the annual limit.
3. HYSA is working well — target $12,000 as the next emergency fund milestone.
4. VOO and VTI are solid long-term holds — no changes needed.

**Risk Level: Low-Medium**`,
  riskLevel: 'low',
  actionReady: true,
  generatedAt: '2026-06-09T09:00:00Z',
};

export const mockFico = 720;
