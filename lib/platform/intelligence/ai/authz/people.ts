/**
 * lib/platform/intelligence/ai/authz/people.ts  (Platform AI — the @ people picker search + the bare-username guard)
 *
 * Owner request 2026-11-10; S2 09fc binding conditions (P1–P6, G1–G6). The privacy invariant is
 * unchanged (owner D1, S2 09ez): customer names, usernames and emails never reach the model provider.
 *
 * ── 1. THE PICKER SEARCH (searchPeople) ───────────────────────────────────────
 * POST /api/platform/ai/people { q } — only for a caller with P5 subject-lookup authority (the customers
 * pack flag ON + a FRESH Customer Success grant with the CS incident tier, I-7: never break-glass), the
 * SAME authority authz/subject.ts requires. Per request:
 *   P1  q is normalised (trim, lower-case) and must be 3–64 of [a-z0-9._+-] — no `@`, no space, no
 *       wildcard: it is matched as a PREFIX of the username or of the email LOCAL PART only (never a
 *       name, a domain or a mid-string), within the customer population (CUSTOMER_WHERE — never an
 *       operator or a System Admin);
 *   P5  the SHARED P5 limiter (checkKeyLimitStrict(operatorId, "platform-ai-subject", 20 / h)) counts
 *       every search; LIMITED / UNAVAILABLE / an aborted or failed read / a failed audit ⇒ the ONE
 *       uniform empty response `{ matches: [] }`; every outcome is padded to SUBJECT_FLOOR_MS; at most
 *       PEOPLE_RESULTS_MAX rows; the read runs under a statement timeout (people.server.ts);
 *   P4  one audit row BEFORE any label leaves the server: detail { queryLength, resultCount } and an
 *       optional keyed fingerprint (HMAC under the PRIV-ref key mechanism with its OWN purpose label —
 *       never the query, never an unkeyed hash). A failed write ⇒ the uniform empty response;
 *   P3  each match is { opaqueRef (8 hex PRIV-ref token), label } — the label goes ONLY to this operator's
 *       response: never logged, never stored, never sent back (the composer sends the chip token,
 *       authz/people-chip.ts; the stored text of a chip is `[customer]`).
 *
 * ── 2. THE BARE-USERNAME GUARD (runPickerGuard) ───────────────────────────────
 * Server-side, on the RAW question, BEFORE the scrub, the subject slots, any spend reservation and any
 * provider call — on every turn (ask, conversation create, conversation follow-up) (G6):
 *   G5  a caller WITHOUT P5 authority gets no username lookup at all; any email-shaped text is refused
 *       (USE_PEOPLE_PICKER — the UI shows the email reminder, without the picker);
 *   G4  a P5 caller's exact email is NOT refused — it is the supported identifier (authz/subject.ts
 *       resolves it to a per-turn handle or the uniform `[customer not resolved]`);
 *   G3  a P5 caller's username-SHAPED whole tokens (3–30 of [a-z0-9_], case-folded) — minus the
 *       identifiers the slot path owns (emails, `user #` refs, chips, cuids) and minus the PRODUCT
 *       VOCABULARY (registry labels, area names, closed codes, router pack terms — people-vocabulary.ts,
 *       built from the registries) — are matched EXACTLY against customer usernames in ONE bounded
 *       indexed query (username IN (…), CUSTOMER_WHERE, take 1);
 *   G1  if the shared P5 limiter is already exhausted the question is refused with the SAME uniform
 *       response (the guard is never skipped); a HIT counts against that limiter; a MISS proceeds and
 *       becomes an ordinary turn (it counts against the daily turn cap like any other);
 *       an aborted / failed lookup ⇒ refused (fail closed), with the same response;
 *   G2  a refusal is NOT a turn: no provider call, nothing stored, no spend reserved; one code-only
 *       audit row (kind USERNAME / EMAIL / LIMITED / UNAVAILABLE — never a token, a username or an email).
 * Every refusal is the one response USE_PEOPLE_PICKER (HTTP 422); the lookup path is padded to the floor.
 * No token text is ever logged or returned.
 *
 * PURE ORCHESTRATION: every effect is injected (people.server.ts wires Production).
 */

import { SUBJECT_ABORT_MS, SUBJECT_FLOOR_MS, extractSubjects, type SubjectClock, type SubjectLimiterVerdict } from "./subject";
import { EMAIL_SHAPED } from "./people-chip";

export const PEOPLE_QUERY_MIN = 3;
export const PEOPLE_QUERY_MAX = 64;
export const PEOPLE_RESULTS_MAX = 8;
/** The keyed fingerprint's own purpose label (S2 09fc P4 — not the reference label). */
export const PEOPLE_FINGERPRINT_LABEL = "fm/platform-ai-people-search/v1";

/** A username-shaped token (the registration / profile USERNAME_RE, case-folded). */
export const USERNAME_SHAPED = /^[a-z0-9_]{3,30}$/;
/** The most distinct tokens one guard query looks up (a 500-character question has fewer). */
export const GUARD_MAX_TOKENS = 128;

// ── 1. the picker search ─────────────────────────────────────────────────────

/** q ⇒ the normalised prefix, or null (too short / long, `@`, whitespace, wildcard or any other character). */
export function normalizePeopleQuery(q: unknown): string | null {
  if (typeof q !== "string") return null;
  const t = q.trim().toLowerCase();
  return t.length >= PEOPLE_QUERY_MIN && t.length <= PEOPLE_QUERY_MAX && /^[a-z0-9._+-]+$/.test(t) ? t : null;
}

/** The picker route's body: exactly `{ q: string }`, normalised; anything else ⇒ null (400). */
export function parsePeopleBody(body: unknown): string | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== "q") return null;
  return normalizePeopleQuery((body as { q: unknown }).q);
}

/** One candidate row from the read (allowlisted columns; never a name). */
export interface PeopleRow { readonly id: string; readonly username: string | null; readonly email: string }
/** One match: the opaque ref (8 hex) and the label shown ONLY to the searching operator. */
export interface PeopleMatch { readonly opaqueRef: string; readonly label: string }

/** The strict prefix rule (P1), applied to every row the read returned: username prefix or email LOCAL-PART prefix. */
export function prefixMatches(rows: readonly PeopleRow[], q: string, refOf: (userId: string) => string | null): PeopleMatch[] {
  const out: PeopleMatch[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const username = (r.username ?? "").toLowerCase();
    const local = (r.email ?? "").toLowerCase().split("@")[0] ?? "";
    if (!(username.startsWith(q) || local.startsWith(q))) continue;
    let ref: string | null = null;
    try { ref = refOf(r.id); } catch { ref = null; }
    if (!ref || !/^[0-9a-f]{8}$/.test(ref) || seen.has(ref)) continue;
    seen.add(ref);
    out.push({ opaqueRef: ref, label: r.username && r.username.length > 0 ? r.username : r.email });
    if (out.length >= PEOPLE_RESULTS_MAX) break;
  }
  return out;
}

export interface PeopleSearchAuditRow { readonly operatorId: string; readonly queryLength: number; readonly resultCount: number; readonly fingerprint: string | null }

export interface PeopleSearchDeps {
  readonly operatorId: string;
  /** The SHARED P5 limiter: checkKeyLimitStrict(operatorId, SUBJECT_LIMITER_NAME, SUBJECT_LIMIT). */
  limit(): Promise<SubjectLimiterVerdict>;
  /** The bounded prefix read within the customer population (statement timeout; ≤ 2 × PEOPLE_RESULTS_MAX rows). */
  search(q: string): Promise<readonly PeopleRow[]>;
  /** userId ⇒ the PRIV-ref token (8 hex), or null without the server key. */
  refOf(userId: string): string | null;
  /** The keyed fingerprint of the normalised query (8 hex), or null. */
  fingerprint(q: string): string | null;
  audit(row: PeopleSearchAuditRow): Promise<void>;
  readonly clock: SubjectClock;
}

const ABORTED = Symbol("aborted");

async function pad(clock: SubjectClock, start: number): Promise<void> {
  const elapsed = clock.now() - start;
  if (elapsed < SUBJECT_FLOOR_MS) await clock.sleep(SUBJECT_FLOOR_MS - elapsed);
}

/** The ONE uniform response for every non-result (limited, unavailable, aborted, audit failure, none). */
export const PEOPLE_EMPTY = Object.freeze({ matches: Object.freeze([]) as readonly PeopleMatch[] });

/** `q` must already be normalised (normalizePeopleQuery). Never throws; never logs; never returns the query. */
export async function searchPeople(q: string, d: PeopleSearchDeps): Promise<{ matches: readonly PeopleMatch[] }> {
  const start = d.clock.now();
  let matches: PeopleMatch[] = [];
  try {
    let verdict: SubjectLimiterVerdict;
    try { verdict = await d.limit(); } catch { verdict = "unavailable"; }
    if (verdict === "ok") {
      const found = await Promise.race([d.search(q).catch(() => ABORTED), d.clock.after(SUBJECT_ABORT_MS).then(() => ABORTED)]);
      if (found !== ABORTED && Array.isArray(found)) matches = prefixMatches(found as PeopleRow[], q, d.refOf);
    }
  } catch { matches = []; }
  let fingerprint: string | null = null;
  try { const f = d.fingerprint(q); fingerprint = typeof f === "string" && /^[0-9a-f]{8}$/.test(f) ? f : null; } catch { fingerprint = null; }
  let audited = false;
  try {
    await d.audit({ operatorId: d.operatorId, queryLength: q.length, resultCount: matches.length, fingerprint });
    audited = true;
  } catch { audited = false; }
  await pad(d.clock, start);
  return audited && matches.length > 0 ? { matches } : PEOPLE_EMPTY;
}

// ── 2. the bare-username guard ───────────────────────────────────────────────

/** Why the guard refused (audit detail only — never returned to the client, never logged with text). */
export type PickerGuardKind = "USERNAME" | "EMAIL" | "LIMITED" | "UNAVAILABLE";
export type PickerGuardVerdict = { readonly pass: true } | { readonly pass: false; readonly kind: PickerGuardKind };

const SLOTS = /\d{1,2}/g;
const WORD = /(?<![A-Za-z0-9_])[A-Za-z0-9_]+(?![A-Za-z0-9_])/g;

/**
 * The RAW question ⇒ whether it holds email-shaped text, and its distinct username-shaped tokens that are
 * not product vocabulary. The identifiers the slot path owns (emails, `user #` refs, chips, cuids) are cut
 * out first (authz/subject.ts extractSubjects), so a chip's hex or a ref is never a candidate. Pure.
 */
export function guardCandidates(raw: string, exempt: (token: string) => boolean): { emailShaped: boolean; tokens: string[] } {
  const ex = extractSubjects(raw);
  const emailShaped = ex.ids.some((i) => i.kind === "EMAIL") || EMAIL_SHAPED.test(ex.text);
  const rest = ex.text.replace(SLOTS, " ");
  const tokens: string[] = [];
  for (const m of rest.matchAll(WORD)) {
    const t = m[0].toLowerCase();
    if (!USERNAME_SHAPED.test(t) || tokens.includes(t)) continue;
    let skip = false;
    try { skip = exempt(t) === true; } catch { skip = false; }
    if (skip) continue;
    tokens.push(t);
    if (tokens.length >= GUARD_MAX_TOKENS) break;
  }
  return { emailShaped, tokens };
}

export interface PickerGuardAuditRow { readonly operatorId: string; readonly p5: boolean; readonly kind: PickerGuardKind }

export interface PickerGuardDeps {
  readonly operatorId: string;
  /** P5 subject-lookup authority NOW: the customers pack flag ON + a fresh CS grant with the CS tier (people.server.ts). */
  authority(): Promise<boolean>;
  /** The product vocabulary (people-vocabulary.ts). */
  exempt(token: string): boolean;
  /** True when the SHARED P5 limiter is already exhausted (a read — it does not count). */
  exhausted(): Promise<boolean>;
  /** Count one HIT against the SHARED P5 limiter. */
  consume(): Promise<SubjectLimiterVerdict>;
  /** ONE bounded exact query: does any CUSTOMER hold one of these usernames (case-folded)? */
  usernameHit(tokens: readonly string[]): Promise<boolean>;
  /** The code-only audit row (never a token). */
  audit(row: PickerGuardAuditRow): Promise<void>;
  readonly clock: SubjectClock;
}

const PASS: PickerGuardVerdict = Object.freeze({ pass: true });

/** Run the guard on the RAW question. Never throws (an internal failure on the lookup path refuses — fail closed). */
export async function runPickerGuard(raw: string, d: PickerGuardDeps): Promise<PickerGuardVerdict> {
  let p5 = false;
  try { p5 = (await d.authority()) === true; } catch { p5 = false; }
  const c = guardCandidates(typeof raw === "string" ? raw : "", (t) => d.exempt(t));
  const refuse = async (kind: PickerGuardKind): Promise<PickerGuardVerdict> => {
    try { await d.audit({ operatorId: d.operatorId, p5, kind }); } catch { /* the refusal stands without its row */ }
    return { pass: false, kind };
  };
  // G5 — no P5 authority: no username lookup at all; any email-shaped text is refused.
  if (!p5) return c.emailShaped ? refuse("EMAIL") : PASS;
  // G4 — a P5 caller's exact email is the supported identifier (the slot path). Only usernames are looked up.
  if (c.tokens.length === 0) return PASS;
  const start = d.clock.now();
  let verdict: PickerGuardVerdict;
  let exhausted = true;
  try { exhausted = (await d.exhausted()) === true; } catch { exhausted = true; }
  if (exhausted) verdict = await refuse("LIMITED"); // G1 — never skip the guard
  else {
    const hit = await Promise.race([d.usernameHit(c.tokens).then((h) => h === true).catch(() => ABORTED), d.clock.after(SUBJECT_ABORT_MS).then(() => ABORTED)]);
    if (hit === ABORTED) verdict = await refuse("UNAVAILABLE");
    else if (hit === true) {
      try { await d.consume(); } catch { /* counted or not, the hit is refused */ }
      verdict = await refuse("USERNAME");
    } else verdict = PASS;
  }
  await pad(d.clock, start);
  return verdict;
}
