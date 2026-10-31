/**
 * lib/platform/growth/beta-risk-core.ts  (Beta-request risk — THE PURE HALF)
 *
 * Explainable, ADVISORY risk signals for the beta-access queue
 * (docs/plans/BETA-REQUEST-RISK-ASSESSMENT-2026-10-31.md §3–§4, owner-approved).
 * No I/O, no clock, no database: lib/platform/growth/beta-risk.ts loads the
 * facts on fm_system and hands them here.
 *
 * ADVISORY ONLY. A level never blocks approval, never hides a request and never
 * changes a status. Wording is "Review suggested" / "High suspicion" — never
 * "bot", "fraud" or "malicious".
 *
 * IDENTITY-FREE OUTPUT. The facts carry opaque keys (digests the reader made)
 * and an e-mail DOMAIN only so the disposable list can be consulted; the output
 * is reason codes, neutral labels and evidence made of counts, a window length
 * and timestamps. No address, IP, user agent, digest or domain ever leaves.
 *
 * SIGNALS (§3) — strength alone:
 *   moderate  BURST_WINDOW, SHARED_NETWORK, AUTOMATION_UA, ALIAS_CLUSTER, DUPLICATE_NOTE
 *   weak      REPEATED_SUBMISSION, DISPOSABLE_DOMAIN, NO_BROWSER_SIGNALS
 *
 * CLASSIFICATION (§4):
 *   high          ≥ 2 moderate, at least one of SHARED_NETWORK / AUTOMATION_UA / BURST_WINDOW
 *   review        ≥ 1 moderate, or ≥ 2 weak
 *   insufficient  no forensic audit row (network + user-agent unevaluable) and
 *                 the evaluable signals do not reach `review`
 *   none          otherwise
 */

import { createHash } from "node:crypto";
import { isDisposableDomain } from "@/lib/marketing/disposable-domains";

// ── Thresholds (named, exported, pinned by the test) ─────────────────────────

/** BURST_WINDOW — at least this many DISTINCT requesters … */
export const BURST_MIN_REQUESTERS = 5;
/** … inside a window this long (minutes), fleet-wide. */
export const BURST_WINDOW_MINUTES = 10;
/** SHARED_NETWORK — the same network digest as at least this many OTHER requesters … */
export const SHARED_NETWORK_MIN_OTHERS = 3;
/** … within this many minutes of the request's own submission (24 h). */
export const SHARED_NETWORK_WINDOW_MINUTES = 24 * 60;
/** REPEATED_SUBMISSION — the same address submitted at least this many times. */
export const REPEATED_SUBMISSION_MIN = 3;
/** ALIAS_CLUSTER — a folded mailbox shared by at least this many requests (itself included). */
export const ALIAS_CLUSTER_MIN = 2;
/** DUPLICATE_NOTE — an identical normalised note on at least this many requests (itself included). */
export const DUPLICATE_NOTE_MIN = 2;
/** A note shorter than this (normalised) is too generic to compare ("hi", "interested"). */
export const DUPLICATE_NOTE_MIN_CHARS = 12;

// ── Vocabulary ───────────────────────────────────────────────────────────────

export const BETA_RISK_REASON_CODES = [
  "BURST_WINDOW", "SHARED_NETWORK", "AUTOMATION_UA", "REPEATED_SUBMISSION",
  "ALIAS_CLUSTER", "DUPLICATE_NOTE", "DISPOSABLE_DOMAIN", "NO_BROWSER_SIGNALS",
] as const;
export type BetaRiskReasonCode = (typeof BETA_RISK_REASON_CODES)[number];

export type BetaRiskLevel = "none" | "review" | "high" | "insufficient";

export const MODERATE_SIGNALS: ReadonlySet<BetaRiskReasonCode> = new Set<BetaRiskReasonCode>([
  "BURST_WINDOW", "SHARED_NETWORK", "AUTOMATION_UA", "ALIAS_CLUSTER", "DUPLICATE_NOTE",
]);
export const WEAK_SIGNALS: ReadonlySet<BetaRiskReasonCode> = new Set<BetaRiskReasonCode>([
  "REPEATED_SUBMISSION", "DISPOSABLE_DOMAIN", "NO_BROWSER_SIGNALS",
]);
/** The network- / automation-based moderates, one of which `high` requires. */
export const HIGH_ANCHOR_SIGNALS: ReadonlySet<BetaRiskReasonCode> = new Set<BetaRiskReasonCode>([
  "SHARED_NETWORK", "AUTOMATION_UA", "BURST_WINDOW",
]);

/** Neutral, plain-language labels. Never "bot", "fraud" or "malicious". */
export const BETA_RISK_REASON_LABEL: Readonly<Record<BetaRiskReasonCode, string>> = {
  BURST_WINDOW:        "Submitted during a burst of requests",
  SHARED_NETWORK:      "Same network as other requesters",
  AUTOMATION_UA:       "Submitted by a non-browser client",
  REPEATED_SUBMISSION: "Submitted several times",
  ALIAS_CLUSTER:       "Address variant of another request",
  DUPLICATE_NOTE:      "Note identical to another request's",
  DISPOSABLE_DOMAIN:   "Disposable email domain",
  NO_BROWSER_SIGNALS:  "No referrer, landing page or campaign",
};

export const BETA_RISK_LEVEL_LABEL: Readonly<Record<BetaRiskLevel, string>> = {
  none:         "No notable signals",
  review:       "Review suggested",
  high:         "High suspicion",
  insufficient: "Insufficient evidence",
};

/** The user-agent family the reader derives IN SQL — the raw string never reaches JS. */
export type UaFamily = "browser" | "script" | "headless" | "empty" | "other";
const NON_BROWSER: ReadonlySet<UaFamily> = new Set<UaFamily>(["script", "headless", "empty", "other"]);

// ── DTO ──────────────────────────────────────────────────────────────────────

export interface BetaRiskEvidence {
  count?: number;
  windowMinutes?: number;
  firstAt?: string;
  lastAt?: string;
}
export interface BetaRiskReason {
  code: BetaRiskReasonCode;
  label: string;
  evidence: BetaRiskEvidence;
}
export interface BetaRiskAssessment {
  level: BetaRiskLevel;
  reasons: BetaRiskReason[];
}

// ── Facts ────────────────────────────────────────────────────────────────────

/** One forensic submission (an AuditLog BETA_ACCESS_REQUESTED row), already reduced in SQL. */
export interface BetaRiskAuditFact {
  at: Date;
  /** Per-read salted digest of the client IP; null when the IP was absent or "unknown". */
  networkDigest: string | null;
  uaFamily: UaFamily | null;
}

export interface BetaRiskRequestFacts {
  requestId: string;
  /** Opaque key of the exact address — the same key space as `fleet.submissions`. */
  requesterKey: string;
  /** Opaque key of the exact address in the AUDIT key space (`fleet.network`). */
  auditKey: string;
  /** canonicalEmailKey() of the address — compared, never output. */
  emailCanonicalKey: string;
  /** Lower-cased domain — consulted against the disposable set, never output. */
  domain: string;
  /** noteFingerprint() of the applicant's note, or null. */
  noteHash: string | null;
  /** Every submission of the public form for this address (BetaAccessRequestEvent.receivedAt). */
  eventTimes: Date[];
  /** Whether ANY submission carried a referrer, landing path or campaign (bounded acquisition source). */
  sourcePresent: boolean;
  /** The forensic audit rows for this address; EMPTY ⇒ network / UA unevaluable. */
  audit: BetaRiskAuditFact[];
}

export interface BetaRiskFleetFacts {
  /** Every submission in the look-back, fleet-wide (BURST_WINDOW). */
  submissions: { requesterKey: string; at: Date }[];
  /** Every forensic row with a network digest in the look-back, fleet-wide (SHARED_NETWORK). */
  network: { auditKey: string; networkDigest: string; at: Date }[];
  /** canonical key → number of DISTINCT requests folding to it (ALIAS_CLUSTER). */
  aliasClusterSizes: ReadonlyMap<string, number>;
  /** note fingerprint → number of requests carrying it (DUPLICATE_NOTE). */
  noteCounts: ReadonlyMap<string, number>;
  /** The disposable-domain set (lib/marketing/disposable-domains.ts by default). */
  disposableDomains?: ReadonlySet<string>;
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

const GMAIL_DOMAINS: ReadonlySet<string> = new Set(["gmail.com", "googlemail.com"]);

/**
 * The mailbox an address delivers to: lower-cased, `+tag` removed, and for
 * gmail.com / googlemail.com the dots removed and the domain folded to
 * gmail.com. Returns the input lower-cased when it has no `@`.
 */
export function canonicalEmailKey(email: string): string {
  const e = email.trim().toLowerCase();
  const at = e.lastIndexOf("@");
  if (at <= 0) return e;
  let local = e.slice(0, at);
  let domain = e.slice(at + 1);
  const plus = local.indexOf("+");
  if (plus >= 0) local = local.slice(0, plus);
  if (GMAIL_DOMAINS.has(domain)) { local = local.replace(/\./g, ""); domain = "gmail.com"; }
  return `${local}@${domain}`;
}

export function emailDomain(email: string): string {
  const e = email.trim().toLowerCase();
  const at = e.lastIndexOf("@");
  return at >= 0 ? e.slice(at + 1) : "";
}

/** Normalised-note digest (lower-case, whitespace collapsed), or null when empty or too short to compare. */
export function noteFingerprint(note: string | null | undefined): string | null {
  if (!note) return null;
  const n = note.toLowerCase().replace(/\s+/g, " ").trim();
  if (n.length < DUPLICATE_NOTE_MIN_CHARS) return null;
  return createHash("sha256").update(n).digest("hex");
}

/** Count how many DISTINCT requests share each value. */
export function tally(values: Iterable<string | null>): Map<string, number> {
  const m = new Map<string, number>();
  for (const v of values) if (v !== null) m.set(v, (m.get(v) ?? 0) + 1);
  return m;
}

const iso = (d: Date) => d.toISOString();
const MIN = 60_000;

interface Window { count: number; first: Date; last: Date }

/**
 * Every fleet window of BURST_WINDOW_MINUTES, anchored at each submission
 * (the classic sliding-window maximum), with its DISTINCT requester count.
 * Computed once per assessment; `sorted` is ascending by time.
 */
function fleetWindows(sorted: { requesterKey: string; at: Date }[]): Window[] {
  const span = BURST_WINDOW_MINUTES * MIN;
  const out: Window[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const start = sorted[i].at.getTime();
    const keys = new Set<string>();
    let last = sorted[i].at;
    for (let j = i; j < sorted.length && sorted[j].at.getTime() <= start + span; j++) {
      keys.add(sorted[j].requesterKey);
      last = sorted[j].at;
    }
    out.push({ count: keys.size, first: sorted[i].at, last });
  }
  return out;
}

/**
 * The densest fleet window that CONTAINS one of the request's own submissions
 * (so the request is itself one of the window's requesters).
 */
function burstFor(times: Date[], windows: Window[]): Window | null {
  let best: Window | null = null;
  const span = BURST_WINDOW_MINUTES * MIN;
  for (const t of times) {
    const tm = t.getTime();
    // First window starting at or after tm - span (binary search on the ascending anchors).
    let lo = 0, hi = windows.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (windows[mid].first.getTime() < tm - span) lo = mid + 1; else hi = mid; }
    for (let i = lo; i < windows.length && windows[i].first.getTime() <= tm; i++) {
      if (!best || windows[i].count > best.count) best = windows[i];
    }
  }
  return best;
}

/** OTHER requesters sharing one of the request's network digests within the window. */
function sharedNetworkFor(req: BetaRiskRequestFacts, byDigest: Map<string, { auditKey: string; at: Date }[]>): Window | null {
  let best: Window | null = null;
  const span = SHARED_NETWORK_WINDOW_MINUTES * MIN;
  for (const a of req.audit) {
    if (!a.networkDigest) continue;
    const rows = byDigest.get(a.networkDigest) ?? [];
    const others = new Set<string>();
    let first: Date | null = null;
    let last: Date | null = null;
    for (const r of rows) {
      if (r.auditKey === req.auditKey) continue;
      if (Math.abs(r.at.getTime() - a.at.getTime()) > span) continue;
      others.add(r.auditKey);
      if (!first || r.at < first) first = r.at;
      if (!last || r.at > last) last = r.at;
    }
    if (others.size > 0 && (!best || others.size > best.count)) best = { count: others.size, first: first!, last: last! };
  }
  return best;
}

export function classify(reasons: readonly { code: BetaRiskReasonCode }[], auditPresent: boolean): BetaRiskLevel {
  const moderate = reasons.filter((r) => MODERATE_SIGNALS.has(r.code));
  const weak = reasons.filter((r) => WEAK_SIGNALS.has(r.code));
  if (moderate.length >= 2 && moderate.some((r) => HIGH_ANCHOR_SIGNALS.has(r.code))) return "high";
  if (moderate.length >= 1 || weak.length >= 2) return "review";
  return auditPresent ? "none" : "insufficient";
}

/** Assess every request against the fleet. Deterministic: same facts ⇒ same output. */
export function assessBetaRisk(requests: readonly BetaRiskRequestFacts[], fleet: BetaRiskFleetFacts): Map<string, BetaRiskAssessment> {
  const windows = fleetWindows([...fleet.submissions].sort((a, b) => a.at.getTime() - b.at.getTime()));
  const byDigest = new Map<string, { auditKey: string; at: Date }[]>();
  for (const n of fleet.network) {
    const list = byDigest.get(n.networkDigest) ?? [];
    list.push({ auditKey: n.auditKey, at: n.at });
    byDigest.set(n.networkDigest, list);
  }
  const disposable = fleet.disposableDomains;

  const out = new Map<string, BetaRiskAssessment>();
  for (const req of requests) {
    const reasons: BetaRiskReason[] = [];
    const add = (code: BetaRiskReasonCode, evidence: BetaRiskEvidence) =>
      reasons.push({ code, label: BETA_RISK_REASON_LABEL[code], evidence });
    const times = [...req.eventTimes].sort((a, b) => a.getTime() - b.getTime());
    const auditPresent = req.audit.length > 0;

    const burst = burstFor(times, windows);
    if (burst && burst.count >= BURST_MIN_REQUESTERS) {
      add("BURST_WINDOW", { count: burst.count, windowMinutes: BURST_WINDOW_MINUTES, firstAt: iso(burst.first), lastAt: iso(burst.last) });
    }

    const shared = sharedNetworkFor(req, byDigest);
    if (shared && shared.count >= SHARED_NETWORK_MIN_OTHERS) {
      add("SHARED_NETWORK", { count: shared.count, windowMinutes: SHARED_NETWORK_WINDOW_MINUTES, firstAt: iso(shared.first), lastAt: iso(shared.last) });
    }

    const automated = req.audit.filter((a) => a.uaFamily !== null && NON_BROWSER.has(a.uaFamily)).sort((a, b) => a.at.getTime() - b.at.getTime());
    if (automated.length > 0) {
      add("AUTOMATION_UA", { count: automated.length, firstAt: iso(automated[0].at), lastAt: iso(automated[automated.length - 1].at) });
    }

    if (times.length >= REPEATED_SUBMISSION_MIN) {
      add("REPEATED_SUBMISSION", { count: times.length, firstAt: iso(times[0]), lastAt: iso(times[times.length - 1]) });
    }

    const alias = fleet.aliasClusterSizes.get(req.emailCanonicalKey) ?? 1;
    if (alias >= ALIAS_CLUSTER_MIN) add("ALIAS_CLUSTER", { count: alias });

    const notes = req.noteHash ? fleet.noteCounts.get(req.noteHash) ?? 1 : 0;
    if (notes >= DUPLICATE_NOTE_MIN) add("DUPLICATE_NOTE", { count: notes });

    if (req.domain && isDisposableDomain(req.domain, disposable)) add("DISPOSABLE_DOMAIN", {});

    // Only evaluable with forensic evidence: an unknown UA is not a "non-browser" one.
    if (auditPresent && !req.sourcePresent && !req.audit.some((a) => a.uaFamily === "browser")) {
      add("NO_BROWSER_SIGNALS", { count: times.length || req.audit.length });
    }

    out.set(req.requestId, { level: classify(reasons, auditPresent), reasons });
  }
  return out;
}
