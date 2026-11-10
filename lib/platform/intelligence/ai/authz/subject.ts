/**
 * lib/platform/intelligence/ai/authz/subject.ts  (Platform AI P5 — subject resolution, I-4 / D-4)
 *
 * Design v2 §7; S2 rulings 5 (keyed hash = the existing PRIV-ref key/purpose) and 09dp (no name
 * lookup or search anywhere; operator-typed names are covered by a UI notice, not a scrub —
 * subject-notice.ts). An operator's question may name a customer by an EXACT identifier only:
 *
 *   EMAIL       a full email address, a whole token, case-folded
 *   OPAQUE_REF  a full opaque reference `user #` + 8 lowercase hex (lib/platform/opaque-user-ref.ts;
 *               NOT the ≥ 6-char tail form the Customer Success list search accepts)
 *   USER_ID     a full user cuid (`c` + 24 lowercase alphanumerics)
 *
 * No name, prefix, partial id, wildcard or fuzzy form is ever looked up. (Incident ids join with
 * the incidents pack, P8, behind its own flag.)
 *
 * WHEN. Server-side, BEFORE the scrub (lib/ai/privacy/scrub.ts) and before any model call:
 *   1. extractSubjects(raw)   — every identifier is cut out of the text and replaced by a private
 *                               SLOT marker (U+E000 n U+E001; those code points are stripped from
 *                               the raw text first, so an operator cannot forge a slot);
 *   2. the caller scrubs the slotted text as before (one scrub; slots survive it);
 *   3. resolveSubjects(ids)   — per identifier, in order, the flow below;
 *   4. fillSubjectSlots       — the MODEL text: a matched slot ⇒ `[customer h_…]` (a handle of
 *                               THIS turn, authz/handles.ts); EVERY other outcome ⇒ the one literal
 *                               SUBJECT_UNRESOLVED_TEXT;
 *      storedSubjectText      — the STORED / displayed text: every slot ⇒ `[customer]` (no handle
 *                               is ever persisted, §6.3; no identifier is ever stored).
 *
 * FLOW PER IDENTIFIER (at most SUBJECT_MAX_PER_QUESTION are looked up; extras are LIMITED):
 *   (1) the per-operator limiter checkKeyLimitStrict(operatorId, "platform-ai-subject",
 *       { limit: 20, windowSec: 3600 }) — every attempt counts, found or not; `unavailable` (or a
 *       throw) ⇒ UNAVAILABLE (fail closed); `limited` ⇒ LIMITED;
 *   (2) eligibility: the customers pack flag ON and a FRESH CUSTOMER_SUCCESS-tier guard (the turn
 *       boundary's per-call recheck) — else NO_ACCESS;
 *   (3) lookup by the exact key (direct indexed read; the opaque ref by the bounded digest scan)
 *       within the customer population; > SUBJECT_ABORT_MS ⇒ UNAVAILABLE;
 *   (4) audit PLATFORM_AI_SUBJECT_LOOKUP — ALWAYS, for every outcome (authz/audit.ts); target USER
 *       only when matched; detail {surface, idKind, outcome, keyHash} where keyHash = the keyed
 *       PRIV-ref digest of the normalised identifier (never the identifier). A failed write ⇒ NOT
 *       resolved;
 *   (5) only then a handle is minted (the boundary re-checks the CS area and re-validates the record).
 *
 * UNIFORM RESPONSE. Every non-match — NOT_FOUND, NO_ACCESS, LIMITED, UNAVAILABLE, a failed audit —
 * gives the same literal, the same server note (SUBJECT_UNRESOLVED_NOTE) and the same HTTP status,
 * and the same TIMING CLASS: each identifier's processing is padded to at least SUBJECT_FLOOR_MS
 * (NO_ACCESS and LIMITED sleep to the floor too). The clock is injected (E0 measures it on a fake clock).
 *
 * PURE ORCHESTRATION: every effect (limiter, eligibility, lookup, audit, mint, hash, clock) is
 * injected (authz/subject.server.ts wires the Production ones). Never logs; never returns an
 * identifier, a user id or a hash to the caller's text.
 */

import type { PlatformArea } from "@prisma/client";

export const SUBJECT_FLOOR_MS = 300;
export const SUBJECT_ABORT_MS = 1_500;
export const SUBJECT_MAX_PER_QUESTION = 2;
export const SUBJECT_LIMITER_NAME = "platform-ai-subject";
export const SUBJECT_LIMIT = Object.freeze({ limit: 20, windowSec: 3600 });

/** The model text for EVERY non-matched identifier (one literal, whatever the reason). */
export const SUBJECT_UNRESOLVED_TEXT = "[customer not resolved]";
/** The stored / displayed text for every identifier (no handle, no identifier is ever stored). */
export const SUBJECT_STORED_TEXT = "[customer]";
/** The one server note for any non-match (never says why). */
export const SUBJECT_UNRESOLVED_NOTE = "A customer in your question could not be looked up. Use the customer's exact email, user ID or reference.";

export const SUBJECT_ID_KINDS = ["EMAIL", "OPAQUE_REF", "USER_ID"] as const;
export type SubjectIdKind = (typeof SUBJECT_ID_KINDS)[number];
export const SUBJECT_OUTCOMES = ["MATCHED", "NOT_FOUND", "NO_ACCESS", "LIMITED", "UNAVAILABLE"] as const;
export type SubjectOutcome = (typeof SUBJECT_OUTCOMES)[number];

export interface SubjectIdentifier {
  readonly kind: SubjectIdKind;
  /** The normalised identifier (email case-folded). In memory only: never stored, logged or sent. */
  readonly normalized: string;
}

// ── 1. extraction (pure) ─────────────────────────────────────────────────────

const SLOT_OPEN = "", SLOT_CLOSE = "";
const SLOT = /(\d{1,2})/g;
const SLOT_CHARS = /[]/g;

/** Whole-token boundaries: an identifier is not part of a longer word / address. */
const PATTERNS: readonly { kind: SubjectIdKind; re: RegExp; norm(s: string): string }[] = [
  { kind: "EMAIL", re: /(?<![A-Za-z0-9._%+@-])[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63})*\.[A-Za-z]{2,24}(?![A-Za-z0-9_%+@-]|\.[A-Za-z0-9])/g, norm: (s) => s.toLowerCase() },
  { kind: "OPAQUE_REF", re: /(?<![A-Za-z0-9_#-])user #[0-9a-f]{8}(?![A-Za-z0-9_-])/g, norm: (s) => s },
  { kind: "USER_ID", re: /(?<![A-Za-z0-9_-])c[a-z0-9]{24}(?![A-Za-z0-9_-])/g, norm: (s) => s },
];

export interface ExtractedSubjects {
  /** The raw text with every identifier replaced by a slot (scrub this, then fill / store). */
  readonly text: string;
  /** Every identifier found, in text order (slot n = ids[n]). */
  readonly ids: readonly SubjectIdentifier[];
}

/** Cut every exact identifier out of the operator's RAW question (before the scrub). Pure. */
export function extractSubjects(raw: string): ExtractedSubjects {
  const text = typeof raw === "string" ? raw.replace(SLOT_CHARS, " ") : "";
  const hits: { start: number; end: number; kind: SubjectIdKind; normalized: string }[] = [];
  for (const p of PATTERNS) {
    for (const m of text.matchAll(p.re)) {
      const start = m.index ?? 0, end = start + m[0].length;
      if (hits.some((h) => start < h.end && end > h.start)) continue; // an earlier kind (email first) owns the span
      hits.push({ start, end, kind: p.kind, normalized: p.norm(m[0]) });
    }
  }
  hits.sort((a, b) => a.start - b.start);
  const capped = hits.slice(0, 99);
  let out = "", at = 0;
  capped.forEach((h, i) => { out += `${text.slice(at, h.start)}${SLOT_OPEN}${i}${SLOT_CLOSE}`; at = h.end; });
  out += text.slice(at);
  return { text: out, ids: capped.map((h) => ({ kind: h.kind, normalized: h.normalized })) };
}

/** The MODEL text: slot n ⇒ fills[n] (absent ⇒ the unresolved literal); stray slot chars removed. */
export function fillSubjectSlots(slotted: string, fills: readonly string[]): string {
  return slotted.replace(SLOT, (_m, n: string) => fills[Number(n)] ?? SUBJECT_UNRESOLVED_TEXT).replace(SLOT_CHARS, "");
}

/** The STORED / displayed text: every slot ⇒ `[customer]` (no handle, no identifier). */
export function storedSubjectText(slotted: string): string {
  return slotted.replace(SLOT, SUBJECT_STORED_TEXT).replace(SLOT_CHARS, "");
}

/** True when the text still carries a slot (the caller must fill or store it). */
export const hasSubjectSlots = (text: string): boolean => /\d{1,2}/.test(text);

// ── 2. resolution (injected effects) ─────────────────────────────────────────

export interface SubjectAuditRow {
  /** The operator and an area they hold FRESH (the eligibility guard's area, else the turn's primary area). */
  readonly actor: { readonly operatorId: string; readonly area: PlatformArea };
  readonly idKind: SubjectIdKind;
  readonly outcome: SubjectOutcome;
  /** 8 hex: the keyed PRIV-ref digest of `${kind}:${normalized}` (S2 ruling 5). Never the identifier. */
  readonly keyHash: string;
  /** The matched customer (MATCHED only), else null. */
  readonly matchedUserId: string | null;
}
export type SubjectAuditWriter = (row: SubjectAuditRow) => Promise<void>;

export type SubjectLimiterVerdict = "ok" | "limited" | "unavailable";

export interface SubjectClock {
  now(): number;
  /** The timing floor's wait. */
  sleep(ms: number): Promise<void>;
  /** The lookup abort deadline (resolves after `ms`; a fake clock may never resolve it). */
  after(ms: number): Promise<void>;
}

export interface SubjectDeps {
  readonly operatorId: string;
  /** The turn's primary guarded area (the audit actor when no fresh area guard is available). */
  readonly primaryArea: PlatformArea;
  /** The customers pack flag (strict getter, default OFF). Read per identifier. */
  enabled(): boolean;
  /** checkKeyLimitStrict(operatorId, SUBJECT_LIMITER_NAME, SUBJECT_LIMIT). */
  limit(): Promise<SubjectLimiterVerdict>;
  /** A FRESH guard decision: { csTier, area } (CS area first), or null when no area survives. */
  eligibility(): Promise<{ csTier: boolean; area: PlatformArea } | null>;
  /** The exact lookup within the customer population: the one matching customer id, or null. */
  lookup(id: SubjectIdentifier): Promise<string | null>;
  audit: SubjectAuditWriter;
  /** A handle of THIS turn for the customer (the boundary re-checks + re-validates), or null. */
  mint(userId: string): Promise<string | null>;
  /** The keyed PRIV-ref digest (8 hex) of the normalised identifier. */
  keyHash(id: SubjectIdentifier): string;
  readonly clock: SubjectClock;
}

export interface SubjectResult {
  /** Per identifier (slot order): the model text for its slot. */
  readonly fills: readonly string[];
  readonly outcomes: readonly SubjectOutcome[];
  /** SUBJECT_UNRESOLVED_NOTE when any identifier did not resolve, else null. */
  readonly note: string | null;
}

const ABORTED = Symbol("aborted");

async function resolveOne(id: SubjectIdentifier, index: number, d: SubjectDeps): Promise<{ fill: string; outcome: SubjectOutcome }> {
  const start = d.clock.now();
  let outcome: SubjectOutcome = "UNAVAILABLE";
  let userId: string | null = null;
  let actorArea: PlatformArea = d.primaryArea;
  try {
    if (index >= SUBJECT_MAX_PER_QUESTION) outcome = "LIMITED";
    else {
      let verdict: SubjectLimiterVerdict;
      try { verdict = await d.limit(); } catch { verdict = "unavailable"; }
      if (verdict === "limited") outcome = "LIMITED";
      else if (verdict !== "ok") outcome = "UNAVAILABLE";
      else {
        let enabled = false;
        try { enabled = d.enabled() === true; } catch { enabled = false; }
        let elig: { csTier: boolean; area: PlatformArea } | null = null;
        try { elig = enabled ? await d.eligibility() : null; } catch { elig = null; }
        if (elig) actorArea = elig.area;
        if (!enabled || !elig || elig.csTier !== true) outcome = "NO_ACCESS";
        else {
          const lookupStart = d.clock.now();
          const found = await Promise.race([d.lookup(id).catch(() => ABORTED), d.clock.after(SUBJECT_ABORT_MS).then(() => ABORTED)]);
          if (found === ABORTED || d.clock.now() - lookupStart > SUBJECT_ABORT_MS) outcome = "UNAVAILABLE";
          else if (typeof found === "string" && found.length > 0) { outcome = "MATCHED"; userId = found; }
          else outcome = "NOT_FOUND";
        }
      }
    }
  } catch { outcome = "UNAVAILABLE"; userId = null; }

  let keyHash = "";
  try { keyHash = d.keyHash(id); } catch { keyHash = ""; }
  let audited = false;
  try {
    await d.audit({ actor: { operatorId: d.operatorId, area: actorArea }, idKind: id.kind, outcome, keyHash, matchedUserId: outcome === "MATCHED" ? userId : null });
    audited = true;
  } catch { audited = false; }

  let handle: string | null = null;
  if (outcome === "MATCHED" && audited && userId) {
    try { handle = await d.mint(userId); } catch { handle = null; }
  }
  const elapsed = d.clock.now() - start;
  if (elapsed < SUBJECT_FLOOR_MS) await d.clock.sleep(SUBJECT_FLOOR_MS - elapsed);
  const resolved = typeof handle === "string" && /^h_[A-Za-z0-9_-]{16}$/.test(handle);
  return { fill: resolved ? `[customer ${handle}]` : SUBJECT_UNRESOLVED_TEXT, outcome: resolved ? "MATCHED" : outcome === "MATCHED" ? "UNAVAILABLE" : outcome };
}

/** Resolve every extracted identifier, in order. Never throws; never returns an identifier. */
export async function resolveSubjects(ids: readonly SubjectIdentifier[], deps: SubjectDeps): Promise<SubjectResult> {
  const fills: string[] = [];
  const outcomes: SubjectOutcome[] = [];
  for (let i = 0; i < ids.length; i++) {
    const r = await resolveOne(ids[i], i, deps);
    fills.push(r.fill);
    outcomes.push(r.outcome);
  }
  return { fills, outcomes, note: outcomes.some((o) => o !== "MATCHED") ? SUBJECT_UNRESOLVED_NOTE : null };
}

/** The real clock (Production). The abort sleep never holds the process open. */
export const REAL_SUBJECT_CLOCK: SubjectClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise<void>((resolve) => { setTimeout(resolve, Math.max(0, ms)); }),
  // The abort deadline is unref'd: a lookup that finished first never holds the process open.
  after: (ms) => new Promise<void>((resolve) => { const t = setTimeout(resolve, Math.max(0, ms)); (t as { unref?: () => void }).unref?.(); }),
};
