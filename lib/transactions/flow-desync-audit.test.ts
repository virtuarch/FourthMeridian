/**
 * lib/transactions/flow-desync-audit.test.ts
 *
 * CCPAY-2F — proves the DISCRIMINATION of scripts/audit-flow-desync.ts without a
 * database. It reproduces that audit's exact per-row decision (recompute through
 * buildFlowInputFromRow → classifyFlow, then compare the persisted flow fields)
 * over hand-built fixtures, asserting the audit BOTH accepts the context-dependent
 * cases the old category-shortcut audit false-flagged (CF-4, CCPAY-2B) AND still
 * detects corruption, AND segregates the never-classified backlog and the
 * btc-sync foreign-authority population.
 *
 * Lives here (not in scripts/) because the framework-free runner discovers
 * ".test.ts" only under lib/ app/ components/. Pure, no DB, tsx-runnable.
 *
 *     npx tsx lib/transactions/flow-desync-audit.test.ts
 *
 * If audit-flow-desync.ts's population rules change, mirror them here — this file
 * is the guard that the audit is neither weakened nor made to false-positive.
 */
import { classifyFlow } from "./flow-classifier";
import { buildFlowInputFromRow } from "./plaid-flow-input";

/** A stored Transaction row as the audit reads it (only the fields it consumes). */
interface AuditFixtureRow {
  classifierVersion: number | null;
  category:          string;
  amount:            number;
  flowType:          string | null;
  flowDirection:     string | null;
  pfcPrimary?:       string | null;
  pfcDetailed?:      string | null;
  accountType?:      string | null;
  debtSubtype?:      string | null;
}

// The audit's exact per-row decision (population 1 branch).
function auditRow(row: AuditFixtureRow): "certified" | "desync" | "backlog" | "foreign" {
  if (row.classifierVersion == null && row.flowType != null) return "foreign";
  if (row.classifierVersion == null) return "backlog";
  const { input } = buildFlowInputFromRow(
    { category: row.category, amount: row.amount, pfcPrimary: row.pfcPrimary ?? null,
      pfcDetailed: row.pfcDetailed ?? null, pfcConfidenceLevel: null, merchantEntityId: null },
    { accountType: row.accountType ?? null, debtSubtype: row.debtSubtype ?? null });
  const c = classifyFlow(input);
  return c.flowType === row.flowType && c.flowDirection === row.flowDirection ? "certified" : "desync";
}

let pass = 0; const fails: string[] = [];
const t = (name: string, got: string, want: string) => {
  if (got === want) pass++; else fails.push(`✗ ${name}: got ${got}, want ${want}`);
};

// 1. CF-4 legitimate: liability Transfer→SPENDING must be ACCEPTED (was a false positive before).
t("CF-4 liability TRANSFER_OUT_ACCOUNT_TRANSFER is certified",
  auditRow({ classifierVersion: 2, category: "Transfer", amount: -692.97, accountType: "debt",
    pfcPrimary: "TRANSFER_OUT", pfcDetailed: "TRANSFER_OUT_ACCOUNT_TRANSFER",
    flowType: "SPENDING", flowDirection: "OUTFLOW" }), "certified");

// 2. CCPAY-2B legitimate (post-backfill): liability Payment outflow → SPENDING is ACCEPTED.
t("CCPAY-2B liability Payment OUTFLOW=SPENDING is certified once persisted",
  auditRow({ classifierVersion: 3, category: "Payment", amount: -387.24, accountType: "debt",
    pfcPrimary: "LOAN_PAYMENTS", pfcDetailed: "LOAN_PAYMENTS_CAR_PAYMENT",
    flowType: "SPENDING", flowDirection: "OUTFLOW" }), "certified");

// 3. Genuine card payment (positive on liability) stays DEBT_PAYMENT — certified.
t("legit card payment inflow is certified",
  auditRow({ classifierVersion: 3, category: "Payment", amount: 5000, accountType: "debt",
    flowType: "DEBT_PAYMENT", flowDirection: "INFLOW" }), "certified");

// 4. CORRUPTION must still be DETECTED — a liability Payment outflow stored as DEBT_PAYMENT
//    (the pre-2B bug) is a real desync now.
t("corrupted: liability Payment outflow stored DEBT_PAYMENT is DETECTED",
  auditRow({ classifierVersion: 3, category: "Payment", amount: -387.24, accountType: "debt",
    pfcPrimary: "LOAN_PAYMENTS", pfcDetailed: "LOAN_PAYMENTS_CAR_PAYMENT",
    flowType: "DEBT_PAYMENT", flowDirection: "INTERNAL" }), "desync");

// 5. CORRUPTION: a plain spend row stored as INCOME is DETECTED.
t("corrupted: Dining outflow stored INCOME is DETECTED",
  auditRow({ classifierVersion: 3, category: "Dining", amount: -40, accountType: "checking",
    flowType: "INCOME", flowDirection: "INFLOW" }), "desync");

// 6. CORRUPTION: a NULL flowType on a classifier-OWNED row is DETECTED (incomplete).
t("corrupted: owned row with null flowType is DETECTED",
  auditRow({ classifierVersion: 3, category: "Transfer", amount: -500, accountType: "checking",
    pfcPrimary: "TRANSFER_OUT", pfcDetailed: "TRANSFER_OUT_ACCOUNT_TRANSFER",
    flowType: null, flowDirection: null }), "desync");

// 7. btc-sync foreign authority (null version, non-null flow) is NOT recomputed.
t("btc-sync foreign-authority row is not a desync",
  auditRow({ classifierVersion: null, category: "Income", amount: 0.01, accountType: "crypto",
    flowType: "INCOME", flowDirection: "INFLOW" }), "foreign");

// 8. never-classified backlog (null version, null flow) is backlog, not a desync.
t("never-classified backlog row is not a desync",
  auditRow({ classifierVersion: null, category: "Payment", amount: -800, accountType: "debt",
    flowType: null, flowDirection: null }), "backlog");

if (fails.length) { console.error(`audit-behavior: ${fails.length} FAILED\n` + fails.join("\n")); process.exit(1); }
console.log(`audit-behavior: all ${pass} checks passed ✓ (accepts CF-4 + CCPAY-2B; still detects corruption; segregates backlog + btc-sync)`);
