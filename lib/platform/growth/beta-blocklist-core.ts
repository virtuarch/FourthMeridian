/**
 * lib/platform/growth/beta-blocklist-core.ts  (owner P2-1 · hashed blocked identifiers)
 *
 * PURE rules for the beta blocklist (docs/plans/BETA-BLOCKED-IDENTIFIER-DESIGN-2026-11-01.md
 * §1, §4, §6, §7). No database, no clock reads, no process.env reads: every
 * input is a value (the env is an OBJECT the caller passes), so each rule is
 * unit-testable and written down once. The I/O lives in beta-blocklist.ts.
 *
 * ── THE IDENTIFIER (§1) ───────────────────────────────────────────────────────
 * `blocklistMailbox` is DELIBERATELY stricter than the risk heuristic's
 * canonicalEmailKey (which strips `+tag` on every domain): a block must never
 * catch a different real person.
 *   · lower-cased and trimmed everywhere;
 *   · gmail.com / googlemail.com: dots removed, `+tag` removed, domain folded
 *     to gmail.com;
 *   · providers documented to deliver `+tag` to the same mailbox: `+tag`
 *     removed, dots KEPT;
 *   · every other domain: exact apart from case — dots and `+` are significant.
 *
 * ── THE KEY (§1) ──────────────────────────────────────────────────────────────
 * HMAC-SHA256 under a DEDICATED versioned secret (the BETA_INTAKE_HASH_KEY_*
 * house pattern): BETA_BLOCKLIST_HMAC_KEY_VERSION selects the WRITE version
 * (default v1); BETA_BLOCKLIST_HMAC_KEY_<V> holds each secret, ≥ 32 chars.
 * Lookups match every configured version, so v1 blocks still match after the
 * switch to v2 while _V1 stays set. Never another secret, never the database.
 *
 * ── PRODUCTION (§1) ───────────────────────────────────────────────────────────
 * Production is `VERCEL_ENV === "production"`, read from the env object on
 * every call. With no usable WRITE key, Production FAILS CLOSED (issuance
 * refuses BLOCKLIST_UNAVAILABLE, a block cannot be written so the deny / verdict
 * rolls back); elsewhere the check is SKIPPED with a warning.
 */

import { createHash, createHmac } from "node:crypto";

const DAY_MS = 86_400_000;

// ── Retention (§6) ────────────────────────────────────────────────────────────

/** A block lasts this long from creation (OWNER: confirm the 2-year default). */
export const BLOCKLIST_RETENTION_DAYS = 730;
/** The ceiling for an expiry correction, from creation (3 years). */
export const BLOCKLIST_MAX_DAYS = 1095;
/** A REMOVED block is deleted this long after its removal (the audit trail still resolves it). */
export const BLOCKLIST_REMOVED_GRACE_DAYS = 90;
/** The earliest a corrected expiry may be: now + 1 day. */
export const BLOCKLIST_MIN_CORRECTION_DAYS = 1;
/** Evidence retainUntil ceiling, from capture (3 years). */
export const EVIDENCE_MAX_RETAIN_DAYS = 1095;

export function blockExpiryFor(createdAt: Date): Date {
  return new Date(createdAt.getTime() + BLOCKLIST_RETENTION_DAYS * DAY_MS);
}

export type ExpiryCorrection = { ok: true; expiresAt: Date } | { ok: false; reason: string };

/** A corrected expiry must lie in [now + 1 day, createdAt + BLOCKLIST_MAX_DAYS]. Refused, never clamped. */
export function checkCorrectedExpiry(raw: unknown, createdAt: Date, now: Date): ExpiryCorrection {
  const t = typeof raw === "string" ? Date.parse(raw) : NaN;
  if (!Number.isFinite(t)) return { ok: false, reason: "expiresAt must be an ISO instant." };
  const min = now.getTime() + BLOCKLIST_MIN_CORRECTION_DAYS * DAY_MS;
  const max = createdAt.getTime() + BLOCKLIST_MAX_DAYS * DAY_MS;
  if (t < min) return { ok: false, reason: `expiresAt must be at least ${BLOCKLIST_MIN_CORRECTION_DAYS} day from now (remove the block to end it now).` };
  if (t > max) return { ok: false, reason: `expiresAt may be at most ${BLOCKLIST_MAX_DAYS} days after the block was created.` };
  return { ok: true, expiresAt: new Date(t) };
}

export type RetainUntilCheck = { ok: true; retainUntil: Date } | { ok: false; reason: string };

/** Evidence retainUntil is REQUIRED and lies in (capturedAt, capturedAt + 3 years]. Refused, never clamped. */
export function checkRetainUntil(raw: unknown, capturedAt: Date): RetainUntilCheck {
  const t = typeof raw === "string" ? Date.parse(raw) : NaN;
  if (!Number.isFinite(t)) return { ok: false, reason: "retainUntil is required (an ISO instant)." };
  if (t <= capturedAt.getTime()) return { ok: false, reason: "retainUntil must be in the future." };
  if (t > capturedAt.getTime() + EVIDENCE_MAX_RETAIN_DAYS * DAY_MS) {
    return { ok: false, reason: `retainUntil may be at most ${EVIDENCE_MAX_RETAIN_DAYS} days (3 years) from now.` };
  }
  return { ok: true, retainUntil: new Date(t) };
}

// ── The identifier (§1) ───────────────────────────────────────────────────────

const GMAIL_DOMAINS: ReadonlySet<string> = new Set(["gmail.com", "googlemail.com"]);

/** Providers documented to deliver `+tag` subaddresses to the same mailbox (dots significant). */
export const PLUS_TAG_PROVIDERS: ReadonlySet<string> = new Set([
  "outlook.com", "hotmail.com", "live.com", "msn.com",
  "icloud.com", "me.com", "mac.com",
  "fastmail.com",
  "proton.me", "protonmail.com", "pm.me",
]);

/** The conservative canonical mailbox a block is keyed on (header). */
export function blocklistMailbox(email: string): string {
  const e = email.trim().toLowerCase();
  const at = e.lastIndexOf("@");
  if (at <= 0) return e;
  let local = e.slice(0, at);
  // A fully-qualified trailing dot (`gmail.com.`) names the same domain.
  let domain = e.slice(at + 1).replace(/\.+$/, "");
  const stripTag = () => { const p = local.indexOf("+"); if (p > 0) local = local.slice(0, p); };
  if (GMAIL_DOMAINS.has(domain)) {
    stripTag();
    local = local.replace(/\./g, "");
    domain = "gmail.com";
  } else if (PLUS_TAG_PROVIDERS.has(domain)) {
    stripTag();
  }
  return `${local}@${domain}`;
}

// ── Keys (§1) ─────────────────────────────────────────────────────────────────

export const BLOCKLIST_KEY_VERSION_VAR = "BETA_BLOCKLIST_HMAC_KEY_VERSION";
export const BLOCKLIST_KEY_PREFIX = "BETA_BLOCKLIST_HMAC_KEY_";
export const BLOCKLIST_DEFAULT_VERSION = "v1";
export const BLOCKLIST_MIN_KEY_LENGTH = 32;
const VERSION_RE = /^v[1-9]\d{0,2}$/;
const KEY_VAR_RE = /^BETA_BLOCKLIST_HMAC_KEY_(V[1-9]\d{0,2})$/;

export interface BlocklistKey { version: string; key: Buffer }

export interface BlocklistKeyring {
  /** The WRITE key (the selected version), or null when it is missing / unusable. */
  current: BlocklistKey | null;
  /** Every usable configured version (lookups match all of them); current first. */
  all: BlocklistKey[];
  /** Why `current` is null (no secret value ever), or null. */
  problem: string | null;
}

export type EnvSource = Record<string, string | undefined>;

/** The keyring from an env OBJECT (default: process.env at call time). Never another secret. */
export function resolveBlocklistKeys(source: EnvSource = process.env): BlocklistKeyring {
  const version = (source[BLOCKLIST_KEY_VERSION_VAR] || BLOCKLIST_DEFAULT_VERSION).trim().toLowerCase();
  const all: BlocklistKey[] = [];
  for (const [name, value] of Object.entries(source)) {
    const m = KEY_VAR_RE.exec(name);
    if (!m || !value || value.length < BLOCKLIST_MIN_KEY_LENGTH) continue;
    all.push({ version: m[1].toLowerCase(), key: Buffer.from(value, "utf8") });
  }
  all.sort((a, b) => Number(a.version.slice(1)) - Number(b.version.slice(1)));
  let current: BlocklistKey | null = null;
  let problem: string | null = null;
  if (!VERSION_RE.test(version)) {
    problem = `${BLOCKLIST_KEY_VERSION_VAR} "${version}" is not v1, v2, …`;
  } else {
    const name = `${BLOCKLIST_KEY_PREFIX}${version.toUpperCase()}`;
    const value = source[name];
    if (!value) problem = `${name} is not set`;
    else if (value.length < BLOCKLIST_MIN_KEY_LENGTH) problem = `${name} is shorter than ${BLOCKLIST_MIN_KEY_LENGTH} characters`;
    else current = all.find((k) => k.version === version) ?? null;
  }
  if (current) {
    all.splice(all.indexOf(current), 1);
    all.unshift(current);
  }
  return { current, all, problem };
}

/** Production = VERCEL_ENV === "production", from the env object (read per call). */
export function isProductionEnv(source: EnvSource = process.env): boolean {
  return source.VERCEL_ENV === "production";
}

/** What the blocklist can do in this environment right now. */
export type BlocklistMode =
  | { mode: "ENFORCE"; keys: BlocklistKeyring & { current: BlocklistKey } }
  /** No usable write key in Production: issuance refuses, block writes fail. */
  | { mode: "UNAVAILABLE"; problem: string }
  /** No usable write key outside Production: checks are skipped (warned once). */
  | { mode: "SKIP"; problem: string };

export function blocklistMode(source: EnvSource = process.env): BlocklistMode {
  const keys = resolveBlocklistKeys(source);
  if (keys.current) return { mode: "ENFORCE", keys: keys as BlocklistKeyring & { current: BlocklistKey } };
  const problem = keys.problem ?? "no usable key";
  return isProductionEnv(source) ? { mode: "UNAVAILABLE", problem } : { mode: "SKIP", problem };
}

export function blocklistHmac(canonical: string, key: Buffer): string {
  return createHmac("sha256", key).update(canonical, "utf8").digest("hex");
}

/** Every (hmac, version) pair a lookup matches, current version first. */
export function identifierPairs(email: string, keys: readonly BlocklistKey[]): { identifierHmac: string; keyVersion: string }[] {
  const canonical = blocklistMailbox(email);
  return keys.map((k) => ({ identifierHmac: blocklistHmac(canonical, k.key), keyVersion: k.version }));
}

/** The only part of an HMAC that ever leaves this module: 8 hex characters. */
export function hmacPrefix(hmac: string): string {
  return hmac.slice(0, 8);
}

/**
 * The ADVISORY-LOCK key for a mailbox: `beta-blocklist-lock:<sha256(canonical mailbox)>`.
 * Deliberately independent of the HMAC key version, so instances mid-rotation (or with
 * no key at all) still serialise on the same lock. It is never stored or logged — Postgres
 * keeps only the 64-bit hash in pg_locks.
 */
export function mailboxLockKey(email: string): string {
  return `beta-blocklist-lock:${createHash("sha256").update(blocklistMailbox(email)).digest("hex")}`;
}
