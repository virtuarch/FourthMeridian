/**
 * lib/transactions/detail-sections.ts
 *
 * TI5-3B — pure, display-only projection of a TransactionDetail DTO into the
 * ordered sections the drawer renders. No React, no DB, no I/O — testable with
 * plain `tsx`, dashboard-agnostic.
 *
 * Rules (enforced here so the UI stays dumb):
 *  - Never emit a null/empty fact row, and never emit an empty section.
 *  - Relationship wording never overclaims: pendingPosted makes no amount claim
 *    (the DTO carries only the counterpart id), and duplicate / transferCandidate
 *    are always hedged ("possible" / "appears to match").
 *  - transferCandidate (TI4 Slice 1) renders a hedged, account-name-free note when
 *    a deterministic owned-account transfer match resolves (KD-15-gated upstream).
 *    refundCandidate remains reserved-null and is never rendered.
 *  - tiFactsVersion and raw provider ids are omitted from the UI.
 */

import type { TransactionDetail } from "@/types";

export interface DetailRow {
  label: string;
  value: string;
}

export interface DetailSection {
  title: string;
  /** Label/value facts (fact sections). */
  rows?: DetailRow[];
  /** Full-width sentences (relationship insights). */
  notes?: string[];
}

// ── formatting helpers ────────────────────────────────────────────────────────

/** ENUM_VALUE → "Enum value" (provider/TI enums are SCREAMING_SNAKE). */
function humanize(v: string): string {
  const s = v.replace(/_/g, " ").toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function money(amount: number, currency: string | null): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency ?? "USD",
    maximumFractionDigits: 2,
  }).format(amount);
}

function signedMoney(amount: number, currency: string | null): string {
  return `${amount > 0 ? "+" : "−"}${money(Math.abs(amount), currency)}`;
}

/** Push a row only when the value is present (non-empty). */
function pushIf(rows: DetailRow[], label: string, value: string | null | undefined): void {
  if (value != null && value !== "") rows.push({ label, value });
}

// ── section builders ──────────────────────────────────────────────────────────

function summary(d: TransactionDetail): DetailSection {
  const rows: DetailRow[] = [];
  pushIf(rows, "Merchant", d.merchantDisplayName ?? d.merchant);
  pushIf(rows, "Amount", signedMoney(d.amount, d.currency ?? null));
  pushIf(rows, "Date", d.date);
  pushIf(rows, "Category", d.category);
  if (d.flowType) {
    pushIf(rows, "Flow", d.flowDirection ? `${humanize(d.flowType)} · ${humanize(d.flowDirection)}` : humanize(d.flowType));
  }
  return { title: "Summary", rows };
}

/**
 * TE-2B — a single, non-technical disclosure when Fourth Meridian can see the
 * money moved but cannot yet say what it was. Honest and user-facing: no
 * confidence numbers, reason codes, provider strings, or ontology terms. Rendered
 * only when the server-derived `needsClassification` is true. Disclosure only —
 * no action/correction workflow in this slice.
 */
function needsClassification(d: TransactionDetail): DetailSection | null {
  if (!d.needsClassification) return null;
  const note =
    d.needsClassificationReason === "UNKNOWN_INFLOW_SOURCE"
      ? "Fourth Meridian can see that money came in, but it can’t yet identify the source."
      : "Fourth Meridian can see that this money moved, but it can’t yet determine why.";
  return { title: "Needs classification", notes: [note] };
}

function account(d: TransactionDetail): DetailSection {
  const a = d.account;
  const rows: DetailRow[] = [];
  pushIf(rows, "Account", a.name);
  pushIf(rows, "Institution", a.institution);
  if (a.mask) pushIf(rows, "Mask", `••••${a.mask}`);
  pushIf(rows, "Type", humanize(a.type));
  return { title: "Account", rows };
}

function transactionIntelligence(d: TransactionDetail): DetailSection {
  const rows: DetailRow[] = [];
  if (d.paymentChannel) pushIf(rows, "Payment channel", humanize(d.paymentChannel));
  if (d.paymentMethod) pushIf(rows, "Payment method", humanize(d.paymentMethod));
  if (d.settlementState) pushIf(rows, "Settlement", humanize(d.settlementState));
  // Authorized vs posted only when the authorization date is known (else the
  // Summary date already covers it).
  if (d.authorizedAt) {
    pushIf(rows, "Authorized", d.authorizedAt);
    pushIf(rows, "Posted", d.date);
  }
  if (d.counterpartyType) pushIf(rows, "Counterparty", humanize(d.counterpartyType));
  // fxApplied is only notable when true; false/null is noise.
  if (d.fxApplied === true) pushIf(rows, "Foreign exchange", "Yes");
  // tiFactsVersion intentionally omitted from the UI (debug/version integer).
  return { title: "Transaction Intelligence", rows };
}

function relationshipIntelligence(d: TransactionDetail): DetailSection {
  const notes: string[] = [];
  const pp = d.relationships.pendingPosted;
  if (pp) {
    if (pp.role === "POSTED_FROM_PENDING") {
      notes.push(
        d.authorizedAt
          ? `Posted from a pending transaction. Authorized ${d.authorizedAt}, posted ${d.date}.`
          : "Posted from a pending transaction.",
      );
    } else {
      notes.push("A posted version of this pending transaction exists.");
    }
  }
  const dup = d.relationships.duplicate;
  if (dup && dup.transactionIds.length > 0) {
    const n = dup.transactionIds.length;
    notes.push(`Possible duplicate — appears to match ${n} other transaction${n > 1 ? "s" : ""} on ${d.date}.`);
  }
  // transferCandidate (TI4 Slice 1) is non-null only when a deterministic
  // owned-account transfer match RESOLVED and passed the KD-15 visibility gate
  // upstream. Hedged and account-name-free — the DTO carries only an id, never a
  // name, and the match is a candidate, not an unqualified claim.
  if (d.relationships.transferCandidate) {
    notes.push("Appears to match a transfer between your own accounts.");
  }
  // refundCandidate is reserved-null: never rendered.
  return { title: "Relationship Intelligence", notes };
}

function provenance(d: TransactionDetail): DetailSection {
  const p = d.provenance;
  const rows: DetailRow[] = [];
  pushIf(rows, "Source", humanize(p.source));
  if (p.source === "import") {
    if (p.importSource) pushIf(rows, "Import", humanize(p.importSource));
    pushIf(rows, "File", p.importFilename);
    if (p.importedAt) pushIf(rows, "Imported", p.importedAt.slice(0, 10));
  }
  // categorySource and raw provider ids are not exposed on the DTO — omitted.
  return { title: "Provenance", rows };
}

function reporting(d: TransactionDetail): DetailSection | null {
  const r = d.reporting;
  if (!r) return null; // clean identity — no conversion to show
  const rows: DetailRow[] = [];
  // V25-FINAL-1 — an unavailable conversion has NO reporting amount: disclose it as
  // unavailable rather than render a fake 0 or a native magnitude in the target label.
  if (r.amount === null || r.unavailable) {
    pushIf(rows, "Reporting amount", `Unavailable — no exchange rate to ${r.currency}`);
  } else {
    pushIf(rows, "Reporting amount", `${money(r.amount, r.currency)}${r.estimated ? " (≈ est.)" : ""}`);
  }
  if (r.rate != null) pushIf(rows, "Rate", String(r.rate));
  if (r.effectiveDateISO) pushIf(rows, "As of", r.effectiveDateISO);
  return { title: "Reporting", rows };
}

// ── entry point ───────────────────────────────────────────────────────────────

/**
 * Ordered, non-empty detail sections for the drawer. A section is dropped when
 * it has neither rows nor notes.
 */
export function buildTransactionDetailSections(d: TransactionDetail): DetailSection[] {
  const sections: (DetailSection | null)[] = [
    summary(d),
    needsClassification(d),
    account(d),
    transactionIntelligence(d),
    relationshipIntelligence(d),
    provenance(d),
    reporting(d),
  ];
  return sections.filter(
    (s): s is DetailSection => s != null && ((s.rows?.length ?? 0) > 0 || (s.notes?.length ?? 0) > 0),
  );
}
