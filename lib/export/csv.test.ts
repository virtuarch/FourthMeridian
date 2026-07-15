/**
 * lib/export/csv.test.ts  (OPS-2 S6)
 *
 * Pure guards for the export CSV serialisers, including the round-trip
 * self-consistency test: a transactions.csv the export writes must be
 * detectable by the SAME importer (lib/imports/csv.ts detectColumns) that
 * reads uploads. Standalone tsx script:
 *
 *     npx tsx lib/export/csv.test.ts
 *
 * Exits 0 on pass / 1 on failure. No DB, no network.
 */

import Papa from "papaparse";
import { detectColumns } from "@/lib/imports/csv";
import { toAccountsCsv, toHoldingsCsv, toSnapshotsCsv, toTransactionsCsv } from "@/lib/export/csv";
import type { ExportAccount, ExportHolding, ExportSnapshot, ExportTransaction } from "@/lib/export/types";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

console.log("export/csv");

// Minimal-but-typed sample rows.
const txns = [
  { id: "t1", accountId: "a1", spaceId: "s1", date: "2026-03-01", merchant: "Coffee Bar", description: "Latte", category: "Dining", amount: -4.5, pending: false, currency: "USD" },
  { id: "t2", accountId: "a1", spaceId: "s1", date: "2026-02-15", merchant: "Employer", description: "Payroll", category: "Income", amount: 3200, pending: false, currency: "USD" },
] as unknown as ExportTransaction[];

const transactionsCsv = toTransactionsCsv(txns);
const parsed = Papa.parse(transactionsCsv, { header: true, skipEmptyLines: true });
const headers = (parsed.meta.fields ?? []) as string[];

// ── Round-trip: the importer can detect our exported columns ──────────────────
const detected = detectColumns(headers);
const detectOk = !("error" in detected);
check("transactions.csv columns are importer-detectable (round-trip)", detectOk, JSON.stringify(detected));
if (detectOk) {
  check("importer maps `date`", detected.date === "date");
  check("importer maps `merchant`", detected.merchant === "merchant");
  check("importer maps `amount`", detected.amount === "amount");
  check("importer maps `category`", detected.category === "category");
}

// ── Round-trip: values survive write → read ──────────────────────────────────
const rows = parsed.data as Record<string, string>[];
check("row count preserved", rows.length === 2);
check("first row date preserved", rows[0]?.date === "2026-03-01");
check("first row amount preserved", rows[0]?.amount === "-4.5");
check("merchant preserved", rows[0]?.merchant === "Coffee Bar");

// ── Other serialisers produce headered, non-empty CSV ─────────────────────────
const accounts = [
  { id: "a1", name: "Checking", type: "checking", institution: "Chase", balance: 100, currency: "USD", lastUpdated: "2026-03-01T00:00:00.000Z", spaceId: "s1", spaceName: "Personal" },
] as unknown as ExportAccount[];
const accountsCsv = toAccountsCsv(accounts);
check("accounts.csv has id + balance headers", accountsCsv.split("\n")[0]?.includes("id") === true && accountsCsv.includes("balance"));

const holdings: ExportHolding[] = [
  // A canonical, fully-valued position (native value + FX-converted reporting value).
  { id: "a2:i-vti", accountId: "a2", symbol: "VTI", name: "Vanguard", quantity: 3,
    price: 250, value: 750, currency: "USD", reportingValue: 600, reportingCurrency: "GBP",
    costBasis: 500, isCash: false, spaceId: "s1", source: "canonical" },
  // An UNVALUED canonical position — retained, value/price BLANK (never 0).
  { id: "a2:i-xyz", accountId: "a2", symbol: "XYZ", name: "Illiquid", quantity: 10,
    price: null, value: null, currency: null, reportingValue: null, reportingCurrency: "GBP",
    costBasis: null, isCash: false, spaceId: "s1", source: "canonical" },
];
const holdingsCsv = toHoldingsCsv(holdings);
const holdingsHeader = holdingsCsv.split("\n")[0] ?? "";
check("holdings.csv has symbol header", holdingsHeader.includes("symbol"));
check("holdings.csv adds reporting_value + reporting_currency columns",
  holdingsHeader.includes("reporting_value") && holdingsHeader.includes("reporting_currency"));
check("holdings.csv adds cost_basis + source columns",
  holdingsHeader.includes("cost_basis") && holdingsHeader.includes("source"));

const holdingRows = (Papa.parse(holdingsCsv, { header: true, skipEmptyLines: true }).data as Record<string, string>[]);
check("valued row: native value in `value`, converted in `reporting_value`",
  holdingRows[0]?.value === "750" && holdingRows[0]?.reporting_value === "600" && holdingRows[0]?.reporting_currency === "GBP");
check("valued row: cost_basis + source emitted",
  holdingRows[0]?.cost_basis === "500" && holdingRows[0]?.source === "canonical");
check("unvalued row: value/price/reporting_value BLANK, never 0",
  holdingRows[1]?.value === "" && holdingRows[1]?.price === "" && holdingRows[1]?.reporting_value === "" && holdingRows[1]?.cost_basis === "");
check("unvalued row: still present (quantity retained)", holdingRows[1]?.quantity === "10" && holdingRows[1]?.symbol === "XYZ");

const snapshots = [
  { date: "2026-03-01", netWorth: 1000, totalAssets: 1000, totalDebt: 0, totalCash: 500, totalSavings: 500, totalInvestments: 0, totalCrypto: 0, cashOnHand: 500, spaceId: "s1", spaceName: "Personal" },
] as unknown as ExportSnapshot[];
const snapshotsCsv = toSnapshotsCsv(snapshots);
check("snapshots.csv has net_worth header", snapshotsCsv.split("\n")[0]?.includes("net_worth") === true);

console.log(failures === 0 ? "\nAll export/csv checks passed." : `\n${failures} failure(s).`);
process.exit(failures === 0 ? 0 : 1);
