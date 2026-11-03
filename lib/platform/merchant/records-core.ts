/**
 * lib/platform/merchant/records-core.ts  (PB-9 — THE definitions behind the Merchant Identity KPIs)
 *
 * Pure (no I/O, no Prisma runtime — client-safe). The classifier, precision,
 * parsing and row shaping. The record-set DEFINITIONS (wheres / SQL) live in
 * records-query.ts, built from the constants here.
 *
 * Every record set a Merchant Identity KPI counts is DEFINED
 * here exactly once, as the Prisma `where` (or SQL fragment) that both the
 * overview KPI count and the drill-down list read (lib/platform/merchant/
 * records.ts). One definition, two consumers — the KPI and the table total are
 * the same query, so they cannot drift.
 *
 *   Merchants           merchantDirectoryFilterSql(null)          every Merchant row
 *   Without a merchant  unlinkedWhere(null)                       live rows, merchantId NULL
 *     ...by class       unlinkedWhere(cls) = UNLINKED ∧ classWhere(cls)
 *   Merged / Dismissed  decisionWhere(verdict, since)             MerchantMergeDecision in the window
 *
 * DENOMINATOR (PB-9 finding). "Linked of N" counts EVERY live (deletedAt NULL)
 * Transaction across all tenants — bank feed, imports AND wallet rows,
 * transfers and income included. The write path mints a merchant for nearly
 * every descriptor (transfers too), so the unlinked remainder is mostly wallet
 * rows plus rows that predate merchant identity. `classifyIdentity` +
 * identityClassWhere (records-query.ts) partition live rows so the hero can say how many of the gap are actionable.
 *
 * NULL SAFETY. `flowType` is nullable; SQL `NOT IN` / `<>` on NULL is NULL (the
 * row silently drops out of BOTH sides). Every negative predicate below spells
 * out the NULL arm (records-query.ts), and the partition test evaluates the wheres with SQL
 * three-valued logic to prove each live row lands in exactly one class.
 */

import { normalizeMerchant } from "@/lib/transactions/merchant";
import {
  IDENTITY_CLASS_META, IDENTITY_CLASSES, MERCHANT_RECORDS_KINDS, MERCHANT_RECORDS_PAGE_SIZE, MERCHANT_RECORDS_QUERY_MAX,
  MERCHANT_RECORDS_SORTS,
  type IdentityClass, type IdentityCoverage, type MerchantRecordsKind, type MerchantRecordsQuery,
  type TransactionProvider,
} from "./records-types";

// ── Identity eligibility (one rule table → the TS classifier AND the wheres) ──

/** Flow types that are a movement between accounts. */
export const TRANSFER_FLOWS = ["TRANSFER", "DEBT_PAYMENT"] as const;
/** The category that names a transfer even when the flow is unclassified. */
export const TRANSFER_CATEGORY = "Transfer" as const;
/** Flow types with no merchant counterparty by nature. */
export const NO_COUNTERPARTY_FLOWS = ["INCOME", "INTEREST", "INVESTMENT", "ADJUSTMENT"] as const;

/** The facts the classification reads — the same three fields the wheres filter on. */
export interface IdentityFacts {
  /** The row's account is an on-chain wallet (FinancialAccount.walletAddress set). */
  wallet: boolean;
  flowType: string | null;
  category: string;
}

/** The TS classifier — first match wins, in the order the wheres encode. */
export function classifyIdentity(f: IdentityFacts): IdentityClass {
  if (f.wallet) return "WALLET";
  if ((f.flowType !== null && (TRANSFER_FLOWS as readonly string[]).includes(f.flowType)) || f.category === TRANSFER_CATEGORY) return "TRANSFER";
  if (f.flowType !== null && (NO_COUNTERPARTY_FLOWS as readonly string[]).includes(f.flowType)) return "NO_COUNTERPARTY";
  return "ELIGIBLE";
}

// ── Coverage precision ────────────────────────────────────────────────────────

/**
 * The linked share as display text — FLOORED to two decimals, so an
 * incomplete share can never read as 100% (7,986 / 8,014 → "99.65%", where
 * Math.round said "100%"). Exact 100% / 0% print without decimals; a non-zero
 * share below 0.01% reads "<0.01%". Null when there is no denominator.
 */
export function formatCoveragePct(linked: number, total: number): string | null {
  if (total <= 0) return null;
  if (linked >= total) return "100%";
  if (linked <= 0) return "0%";
  // Integer arithmetic (basis points × 100) — no float rounding up past the floor.
  const hundredths = Math.floor((linked * 10_000) / total);
  if (hundredths === 0) return "<0.01%";
  if (hundredths % 100 === 0) return `${hundredths / 100}%`;
  return `${(hundredths / 100).toFixed(2)}%`;
}

export function emptyCoverage(): IdentityCoverage {
  return { live: 0, linked: 0, unlinked: 0, eligible: 0, eligibleLinked: 0, unlinkedByClass: { ELIGIBLE: 0, TRANSFER: 0, WALLET: 0, NO_COUNTERPARTY: 0 } };
}

// ── Query parsing (the route's and the URL's one parser) ─────────────────────

export type ParsedQuery = { ok: true; query: MerchantRecordsQuery } | { ok: false; error: string };

/** Clamp + clean a search term: letters, spaces and a little punctuation; no digits. */
export function cleanSearch(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.normalize("NFKC").replace(/[^\p{L}\s&'.\-*]/gu, " ").replace(/\s+/g, " ").trim().slice(0, MERCHANT_RECORDS_QUERY_MAX);
  return s.length >= 2 ? s : null;
}

/** Merchant ids are opaque cuids; a directory search may name one exactly. */
export function cleanDirectorySearch(raw: string | null | undefined): string | null {
  if (raw && /^c[a-z0-9]{20,32}$/.test(raw.trim())) return raw.trim();
  return cleanSearch(raw);
}

export function parseRecordsQuery(p: URLSearchParams): ParsedQuery {
  const kind = p.get("kind");
  if (!kind || !(MERCHANT_RECORDS_KINDS as readonly string[]).includes(kind)) return { ok: false, error: "kind must be merchants, unlinked, merged or dismissed" };
  const k = kind as MerchantRecordsKind;
  const w = p.get("window");
  if (w !== null && w !== "30" && w !== "90") return { ok: false, error: "window must be 30 or 90" };
  const sorts = MERCHANT_RECORDS_SORTS[k] as readonly string[];
  const sort = p.get("sort");
  if (sort !== null && !sorts.includes(sort)) return { ok: false, error: `sort must be one of ${sorts.join(", ")}` };
  const pageRaw = p.get("page");
  const page = pageRaw === null ? 1 : Number(pageRaw);
  if (!Number.isInteger(page) || page < 1 || page > 100_000) return { ok: false, error: "page must be a positive integer" };
  const filterRaw = p.get("filter");
  if (filterRaw !== null && (k !== "unlinked" || !(IDENTITY_CLASSES as readonly string[]).includes(filterRaw))) {
    return { ok: false, error: "filter applies to unlinked only and must be an identity class" };
  }
  return {
    ok: true,
    query: {
      kind: k,
      window: w === "90" ? 90 : 30,
      q: k === "merchants" ? cleanDirectorySearch(p.get("q")) : cleanSearch(p.get("q")),
      sort: sort ?? sorts[0],
      page,
      filter: (filterRaw as IdentityClass | null) ?? null,
    },
  };
}

/** Page arithmetic: a page past the end clamps to the last page (never an empty "page 9 of 3"). */
export function pageWindow(total: number, page: number, size: number = MERCHANT_RECORDS_PAGE_SIZE): { page: number; pageCount: number; skip: number; take: number } {
  const pageCount = Math.max(1, Math.ceil(total / size));
  const p = Math.min(Math.max(1, page), pageCount);
  return { page: p, pageCount, skip: (p - 1) * size, take: size };
}

// ── Row shaping ───────────────────────────────────────────────────────────────

/**
 * A provider descriptor made safe for an operator list: normalized (processor
 * prefixes, store / reference numbers and masked card tails dropped), then any
 * residual digit run ≥ 4, long opaque token (addresses, hashes, references),
 * e-mail address or URL masked, and clamped to 40 characters.
 */
export function sanitizeDescriptor(raw: string | null | undefined): string | null {
  if (!raw || !raw.trim()) return null;
  let s = normalizeMerchant(raw).canonicalName;
  s = s
    .replace(/\S+@\S+/g, "[email]")
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, "[link]")
    .replace(/\b(?=[A-Za-z]*\d)[A-Za-z0-9]{16,}\b/g, "[ref]")
    .replace(/\d{4,}/g, "••••")
    .replace(/\s+/g, " ")
    .trim();
  return s.length > 40 ? `${s.slice(0, 39)}…` : s;
}

export function providerOf(r: { plaidTransactionId: string | null; importBatchId: string | null; wallet: boolean }): TransactionProvider {
  if (r.wallet) return "WALLET";
  if (r.plaidTransactionId) return "BANK_FEED";
  if (r.importBatchId) return "IMPORT";
  return "OTHER";
}

export interface UnlinkedRowFacts {
  id: string;
  date: Date;
  merchant: string;
  category: string;
  flowType: string | null;
  plaidTransactionId: string | null;
  importBatchId: string | null;
  accountType: string;
  /** The account is an on-chain wallet (a null-test on its address — never the address). */
  wallet: boolean;
}

/** One "Without a merchant" row. The raw descriptor never leaves this function unsanitized. */
export function shapeUnlinkedRow(r: UnlinkedRowFacts) {
  const wallet = r.wallet;
  const identityClass = classifyIdentity({ wallet, flowType: r.flowType, category: r.category });
  const expected = IDENTITY_CLASS_META[identityClass].expected;
  return {
    id: r.id,
    date: r.date.toISOString().slice(0, 10),
    descriptor: expected ? sanitizeDescriptor(r.merchant) : null,
    provider: providerOf({ plaidTransactionId: r.plaidTransactionId, importBatchId: r.importBatchId, wallet }),
    accountType: r.accountType,
    flowType: r.flowType,
    category: r.category,
    identityClass,
    expected,
  };
}

/** The audit record's facts a decision row shows (MERCHANT_MERGE_APPLIED / _DISMISSED metadata). */
export function auditFacts(metadata: unknown): { affected: number | null; reason: { code: string; note: string | null } | null } {
  const m = (metadata && typeof metadata === "object" ? metadata : {}) as Record<string, unknown>;
  const per = Array.isArray(m.perDuplicate) ? (m.perDuplicate as Record<string, unknown>[]) : null;
  const affected = per ? per.reduce((a, d) => a + (typeof d?.transactionsRepointed === "number" ? d.transactionsRepointed : 0), 0) : null;
  const r = m.reason && typeof m.reason === "object" ? (m.reason as Record<string, unknown>) : null;
  const reason = r && typeof r.code === "string" ? { code: r.code, note: typeof r.note === "string" ? r.note : null } : null;
  return { affected, reason };
}
