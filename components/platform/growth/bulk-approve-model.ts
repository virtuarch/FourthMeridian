/**
 * components/platform/growth/bulk-approve-model.ts  (PR C · bulk beta approval)
 *
 * The PURE half of Growth's bulk approval UI: selection, the review-flag
 * acknowledgement rule, the confirm guard, and the one-batchKey-per-review
 * session. No React, no fetch — unit-tested directly.
 *
 * The client is NEVER authoritative. `eligibility` (from the list route) only
 * decides which checkboxes are enabled; the server re-decides every row at the
 * dry run and again at execution, and its answer is what the review and the
 * results show.
 */

import type {
  BulkDryRunRow, BulkEmailFailed, BulkFailed, BulkSkipped, BulkSucceeded, BulkSummary, BulkValidity,
} from "@/lib/platform/growth/bulk-approve.core";

export const BULK_APPROVE_URL = "/api/platform/growth-revenue/requests/bulk-approve";

// ── Response shapes (the route's JSON) ───────────────────────────────────────

export type BulkDryRunResponse = {
  ok: true; dryRun: true; batchKey: string; rows: BulkDryRunRow[]; duplicates: string[];
  summary: { requested: number; unique: number; duplicates: number; eligible: number; ineligible: number };
} & BulkValidity;

export type BulkExecuteResponse = {
  ok: true; dryRun: false; batchKey: string; summary: BulkSummary; repeat: boolean; batchAudited: boolean;
  succeeded: BulkSucceeded[]; emailFailed: BulkEmailFailed[]; skipped: BulkSkipped[]; failed: BulkFailed[]; duplicates: string[];
} & BulkValidity;

// ── Selection ────────────────────────────────────────────────────────────────

/** What a list row needs for selection. `eligibility` absent ⇒ selectable (the server still decides). */
export interface SelectableRow {
  id: string;
  eligibility?: { approvable: boolean; reason?: string };
}

export const isSelectable = (r: SelectableRow): boolean => r.eligibility?.approvable !== false;

/** Why a checkbox is disabled, or null when it is enabled. */
export function disabledReason(r: SelectableRow): string | null {
  return isSelectable(r) ? null : (r.eligibility?.reason ?? "Not eligible for approval.");
}

export function toggleSelected(selected: ReadonlySet<string>, row: SelectableRow): Set<string> {
  const next = new Set(selected);
  if (next.has(row.id)) next.delete(row.id);
  else if (isSelectable(row)) next.add(row.id);
  return next;
}

/** The header checkbox: every ELIGIBLE row on the page, or none when they are all already selected. */
export function toggleAllEligible(selected: ReadonlySet<string>, pageRows: readonly SelectableRow[]): Set<string> {
  const eligible = pageRows.filter(isSelectable).map((r) => r.id);
  const allOn = eligible.length > 0 && eligible.every((id) => selected.has(id));
  const next = new Set(selected);
  for (const id of eligible) { if (allOn) next.delete(id); else next.add(id); }
  return next;
}

export function headerState(selected: ReadonlySet<string>, pageRows: readonly SelectableRow[]): "none" | "some" | "all" {
  const eligible = pageRows.filter(isSelectable);
  const on = eligible.filter((r) => selected.has(r.id)).length;
  return on === 0 ? "none" : on === eligible.length ? "all" : "some";
}

/** Drop ids that are no longer listed (after a refetch the queue may have moved). */
export function pruneSelection(selected: ReadonlySet<string>, listed: readonly SelectableRow[]): Set<string> {
  const ids = new Set(listed.map((r) => r.id));
  return new Set([...selected].filter((id) => ids.has(id)));
}

// ── Review flags (the agreed contract with the risk session) ─────────────────

/**
 * The advisory risk another session adds to each row. Typed loosely and
 * OPTIONAL: absent today, and never sent to the server.
 */
export interface RiskLike {
  level?: string;
  review?: { status?: string } | null;
}

/**
 * flagged = selected rows whose risk is "review" or "high" and whose review is
 * not LEGITIMATE. Flags never remove or block a row; they only require the
 * operator's explicit acknowledgement before Confirm.
 */
export function flaggedRows<T extends { risk?: RiskLike | null }>(selected: readonly T[]): T[] {
  return selected.filter((r) => r.risk && (r.risk.level === "review" || r.risk.level === "high") && r.risk.review?.status !== "LEGITIMATE");
}

export function flaggedLine(flagged: number, selected: number): string | null {
  return flagged > 0 ? `${flagged} of ${selected} selected have review flags` : null;
}

/** Confirm is enabled only with something to approve, nothing in flight, and any flags acknowledged. */
export function confirmEnabled(s: { inFlight: boolean; eligible: number; flagged: number; acknowledged: boolean }): boolean {
  return !s.inFlight && s.eligible > 0 && (s.flagged === 0 || s.acknowledged);
}

// ── One batchKey per review session ──────────────────────────────────────────

/**
 * A review session holds ONE batchKey from "Review & approve" until the
 * operator finishes or cancels. Every dry run and every Confirm (including a
 * retry after a failed request) reuses it, so the server sees one batch.
 */
export class BatchSession {
  private key: string | null = null;
  constructor(private readonly mint: () => string) {}
  /** Start (or continue) a review: the current key, minting one only if none is open. */
  begin(): string { return (this.key ??= this.mint()); }
  /** The key a Confirm sends — the open session's, never a fresh one. */
  current(): string | null { return this.key; }
  /** Finish or cancel: the next review is a new batch. */
  end(): void { this.key = null; }
}

export function newBatchKey(): string {
  return globalThis.crypto.randomUUID();
}

// ── Copy ─────────────────────────────────────────────────────────────────────

export const daysWord = (n: number) => `${n} day${n === 1 ? "" : "s"}`;

/** "Approve 12 selected requests — invitation valid for 14 days" */
export function previewHeadline(eligible: number, validityDays: number): string {
  return `Approve ${eligible} selected request${eligible === 1 ? "" : "s"} — invitation valid for ${daysWord(validityDays)}`;
}

/** "Expires 14 Nov 2026, 09:30 UTC" — the absolute expiry if issued now, always UTC-labelled. */
export function utcExpiryLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const date = d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" });
  return `${date}, ${time} UTC`;
}

export function resultsLine(s: BulkSummary): string {
  const email = s.emailFailed > 0 ? ` (${s.emailFailed} email not sent)` : "";
  return `${s.succeeded} approved${email} · ${s.skipped} skipped · ${s.failed} failed`;
}

/**
 * The server answered `repeat`: this batchKey was submitted before. Rows the
 * earlier run approved now read "already approved" (skipped) — say so, rather
 * than leave a bare "0 approved".
 */
export const REPEAT_LINE =
  "This batch was already submitted — results reflect the earlier run: rows it approved show as skipped (already approved), and nothing was sent twice.";

/** The validity the operator typed: null = the configured setting; otherwise must be a whole number in bounds. */
export function parseDaysDraft(draft: string | null, min: number, max: number): { ok: true; override: number | null } | { ok: false } {
  if (draft === null) return { ok: true, override: null };
  const t = draft.trim();
  if (!/^\d+$/.test(t)) return { ok: false };
  const n = Number(t);
  return n >= min && n <= max ? { ok: true, override: n } : { ok: false };
}
