/**
 * scripts/lib/synthetic-operator.core.ts — the PURE gate and rules for the
 * synthetic Preview-only Platform operator (acceptance testing).
 *
 * Owner-authorized: ONE dedicated, fabricated operator account on Preview (or a
 * local / throwaway database), approved by S2 with the rulings pinned here and
 * in scripts/synthetic-operator.test.ts:
 *
 *   · exactly one User, role USER, fabricated name, an @example.test address
 *     (RFC 2606 reserved — undeliverable); any other address is refused;
 *   · grants: PLATFORM_OPS at READ (the held area) and GROWTH_REVENUE at READ
 *     (revoked mid-test for the lost-area export case). NEVER CUSTOMER_SUCCESS,
 *     never MERCHANT_OPS, never WRITE / CONTROL, never SYSTEM_ADMIN;
 *   · --env=preview | --env=local only, PROVEN by the connection through
 *     scripts/lib/repair-env-guard.ts (apply mode), exactly as the Platform AI
 *     purge dispatch does; --env=production is ALWAYS refused;
 *   · a cleanup DEADLINE = min(provision + 14 days, 2026-11-19T23:59:59Z).
 *
 * PROFILE e0-live (S2 ruling R-1, E0-LIVE design §5.2 — 2026-11-10) is a
 * SEPARATE, opt-in rule set selected only by `--profile=e0-live`:
 *
 *   · Preview ONLY (--env=local is refused too), proven by the same guard;
 *   · a FIXED roster of five fabricated users — ops (PLATFORM_OPS READ),
 *     cs1–cs3 (CUSTOMER_SUCCESS READ), rev (PLATFORM_OPS + CUSTOMER_SUCCESS
 *     READ) — at e0l-<role>@example.test; nothing else is ever provisioned;
 *   · CUSTOMER_SUCCESS is grantable ONLY under this profile; the default (G1)
 *     profile's allowlist and FORBIDDEN_AREAS are unchanged, so it can never
 *     get CS. SECURITY_OPS / MERCHANT_OPS / SYSTEM_ADMIN: never, any profile;
 *   · --revoke-area / --regrant-area act ONLY on the `rev` operator;
 *   · the cleanup DEADLINE is the provision UTC day at 23:59:59Z.
 *
 * ⚠️ PURE and SECRET-FREE: no database, no filesystem, no network. Refusals name
 * the RULE, never a URL, host, user, ref or secret.
 */

import path from "node:path";
import type { PlaidItemStatus } from "@prisma/client";
import { decideRepairEnvGuard } from "./repair-env-guard";

// ── Identity (fabricated) ────────────────────────────────────────────────────

export const SYNTHETIC_EMAIL_DOMAIN = "@example.test";
export const SYNTHETIC_EMAIL = `synthetic-operator${SYNTHETIC_EMAIL_DOMAIN}`;
export const SYNTHETIC_USERNAME = "synthetic_operator";
export const SYNTHETIC_FIRST_NAME = "Synthetic";
export const SYNTHETIC_LAST_NAME = "Operator";
/** The reason recorded on every audit row this tool writes. */
export const SYNTHETIC_REASON = "synthetic acceptance operator";
/** The ONLY UserRole this tool ever writes. */
export const SYNTHETIC_ROLE = "USER" as const;

/** True only for a lower-case, single-@ address in the reserved .test domain. */
export function isSyntheticEmailAllowed(email: string): boolean {
  if (typeof email !== "string") return false;
  if (email !== email.trim().toLowerCase()) return false;
  if ((email.match(/@/g) ?? []).length !== 1) return false;
  if (!email.endsWith(SYNTHETIC_EMAIL_DOMAIN)) return false;
  const local = email.slice(0, -SYNTHETIC_EMAIL_DOMAIN.length);
  return /^[a-z0-9][a-z0-9._+-]{0,63}$/.test(local);
}

// ── Grants (hard-coded allowlist — S2) ───────────────────────────────────────

export type SyntheticArea = "PLATFORM_OPS" | "GROWTH_REVENUE";
export type SyntheticLevel = "READ";

/** EXACTLY these grants, nothing else. Pinned by the test. */
export const SYNTHETIC_GRANTS: ReadonlyArray<Readonly<{ area: SyntheticArea; level: SyntheticLevel }>> = Object.freeze([
  Object.freeze({ area: "PLATFORM_OPS" as const, level: "READ" as const }),
  Object.freeze({ area: "GROWTH_REVENUE" as const, level: "READ" as const }),
]);

/** Areas this tool must never grant, whatever the allowlist says. */
export const FORBIDDEN_AREAS: ReadonlySet<string> = new Set(["CUSTOMER_SUCCESS", "MERCHANT_OPS", "SECURITY_OPS"]);
/** The only level this tool ever writes. */
export const ALLOWED_LEVELS: ReadonlySet<string> = new Set(["READ"]);

/** True only when (area, level) is in the allowlist (and never forbidden). */
export function isGrantAllowed(area: string, level: string): boolean {
  if (FORBIDDEN_AREAS.has(area) || !ALLOWED_LEVELS.has(level)) return false;
  return SYNTHETIC_GRANTS.some((g) => g.area === area && g.level === level);
}

/** Areas that --revoke-area accepts: the allowlist's areas only. */
export function isRevocableArea(area: string): area is SyntheticArea {
  return !FORBIDDEN_AREAS.has(area) && SYNTHETIC_GRANTS.some((g) => g.area === area);
}

// ── Deadline ─────────────────────────────────────────────────────────────────

export const CLEANUP_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
/** The owner's hard stop for the synthetic operator. */
export const HARD_DEADLINE = new Date("2026-11-19T23:59:59Z");

/** min(provision + 14 days, HARD_DEADLINE). */
export function computeCleanupDeadline(provisionedAt: Date): Date {
  const window = provisionedAt.getTime() + CLEANUP_WINDOW_MS;
  return new Date(Math.min(window, HARD_DEADLINE.getTime()));
}

// ── Private record location ──────────────────────────────────────────────────

export const PRIVATE_DIR_PREFIX = "synthetic-operator-";
const PRIVATE_DIR_NAME = /^synthetic-operator-\d{8}T\d{6}Z$/;

/** `20261105T120000Z` — the UTC stamp of the private directory. */
export function utcStamp(at: Date): string {
  return at.toISOString().replace(/\.\d{3}Z$/, "Z").replace(/[-:]/g, "");
}

export function privateDirFor(privateBase: string, at: Date): string {
  return path.join(privateBase, `${PRIVATE_DIR_PREFIX}${utcStamp(at)}`);
}

/**
 * --record must name a synthetic-operator-<stamp> directory directly inside the
 * private base (~/FourthMeridian-private). Returns a refusal, or null.
 */
export function recordDirRefusal(recordDir: string, privateBase: string): string | null {
  const abs = path.resolve(recordDir);
  const base = path.resolve(privateBase);
  if (path.dirname(abs) !== base || !PRIVATE_DIR_NAME.test(path.basename(abs))) {
    return "--record must be a synthetic-operator-<UTC stamp> directory directly inside the private evidence base.";
  }
  return null;
}

// ── Command gate ─────────────────────────────────────────────────────────────

export const SYNTHETIC_FLAGS = new Set(["env", "provision", "revoke-area", "cleanup", "record"]);
/** Flags that exist ONLY under --profile=e0-live (refused by the default profile). */
export const E0_LIVE_ONLY_FLAGS = new Set(["operator", "await-signal", "regrant-area"]);
/** Every flag the CLI parses (the default profile still refuses E0_LIVE_ONLY_FLAGS). */
export const ALL_FLAGS = new Set([...SYNTHETIC_FLAGS, "profile", ...E0_LIVE_ONLY_FLAGS]);

export type SyntheticCommand =
  | { kind: "provision" }
  | { kind: "revoke-area"; area: SyntheticArea }
  | { kind: "cleanup"; recordDir: string };

export type E0LiveCommand =
  | { kind: "provision" }
  | { kind: "revoke-area"; area: E0LiveArea; operator: "rev"; awaitSignal: boolean }
  | { kind: "regrant-area"; area: E0LiveArea; operator: "rev" }
  | { kind: "cleanup"; recordDir: string };

export type SyntheticDecision =
  | { ok: true; profile: "g1"; env: "local" | "preview"; targetHash: string | null; command: SyntheticCommand }
  | { ok: true; profile: "e0-live"; env: "preview"; targetHash: string | null; command: E0LiveCommand }
  | { ok: false; reasons: string[] };

function flagValue(args: readonly string[], name: string): string | null | undefined {
  const hits = args.filter((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (hits.length === 0) return undefined;
  if (hits.length > 1) return null;
  const a = hits[0];
  return a.includes("=") ? a.slice(a.indexOf("=") + 1) : "";
}

export function decideSyntheticOperator(args: readonly string[], env: NodeJS.ProcessEnv): SyntheticDecision {
  const refuse = (...reasons: string[]): SyntheticDecision => ({ ok: false, reasons });

  const unknown = args.filter((a) => !a.startsWith("--") || !ALL_FLAGS.has(a.replace(/^--/, "").split("=")[0]));
  if (unknown.length) return refuse(`unknown argument(s): ${unknown.map((a) => a.split("=")[0]).join(", ")} — refusing rather than guessing.`);
  for (const name of ALL_FLAGS) {
    if (flagValue(args, name) === null) return refuse(`--${name} given more than once.`);
  }
  const profile = flagValue(args, "profile");
  if (profile !== undefined) {
    if (profile !== E0_LIVE_PROFILE) return refuse(`--profile must be exactly \`${E0_LIVE_PROFILE}\` (omit it for the default acceptance operator).`);
    return decideE0Live(args, env);
  }
  const e0Only = [...E0_LIVE_ONLY_FLAGS].filter((n) => flagValue(args, n) !== undefined);
  if (e0Only.length) return refuse(`${e0Only.map((n) => `--${n}`).join(", ")} exist only under --profile=${E0_LIVE_PROFILE}.`);

  const envFlag = flagValue(args, "env");
  if (envFlag === undefined || envFlag === "") return refuse("exactly one --env=<local|preview> is required.");
  if (envFlag === "production") {
    return refuse("--env=production is refused: the synthetic operator is Preview-only (or a local/throwaway database).");
  }
  if (envFlag !== "local" && envFlag !== "preview") return refuse("--env must be exactly `local` or `preview`.");

  const provision = flagValue(args, "provision");
  const revoke = flagValue(args, "revoke-area");
  const cleanup = flagValue(args, "cleanup");
  const record = flagValue(args, "record");
  const commands = [provision, revoke, cleanup].filter((v) => v !== undefined).length;
  if (commands !== 1) return refuse("exactly one of --provision, --revoke-area=<AREA>, --cleanup is required.");
  if (provision !== undefined && provision !== "") return refuse("--provision takes no value.");
  if (cleanup !== undefined && cleanup !== "") return refuse("--cleanup takes no value.");
  if (record !== undefined && cleanup === undefined) return refuse("--record applies only to --cleanup.");

  let command: SyntheticCommand;
  if (provision !== undefined) {
    command = { kind: "provision" };
  } else if (revoke !== undefined) {
    if (!revoke || !isRevocableArea(revoke)) {
      return refuse("--revoke-area must name an area in the synthetic operator's allowlist (PLATFORM_OPS or GROWTH_REVENUE).");
    }
    command = { kind: "revoke-area", area: revoke };
  } else {
    if (!record) return refuse("--cleanup requires --record=<path to the private synthetic-operator directory>.");
    command = { kind: "cleanup", recordDir: record };
  }

  const gate = decideRepairEnvGuard({
    apply: true, envFlag, databaseUrl: env.DATABASE_URL, directUrl: env.DIRECT_URL,
    productionRef: env.FM_PRODUCTION_DB_REF, vercelEnv: env.VERCEL_ENV, env,
  });
  if (!gate.ok) return refuse(...gate.reasons);
  if (gate.env !== "local" && gate.env !== "preview") return refuse("the environment could not be proven non-Production.");
  return { ok: true, profile: "g1", env: gate.env, targetHash: gate.targetHash, command };
}

// ── Records ──────────────────────────────────────────────────────────────────

/** Generate a 32-character password from a random byte source (base64url alphabet). */
export function passwordFromBytes(bytes: Buffer): string {
  if (bytes.length < 24) throw new Error("need at least 24 random bytes for a 32-character password");
  const s = bytes.subarray(0, 24).toString("base64url");
  if (s.length !== 32) throw new Error("password length invariant broken");
  return s;
}

export interface SyntheticRecord {
  kind: "synthetic-operator-record";
  env: "local" | "preview";
  targetHash: string | null;
  email: string;
  userId: string;
  grantIds: Record<string, string>;
  provisionedAt: string;
  cleanupDeadline: string;
}

export function parseSyntheticRecord(raw: unknown): SyntheticRecord {
  const r = raw as Partial<SyntheticRecord> | null;
  if (!r || r.kind !== "synthetic-operator-record") throw new Error("not a synthetic-operator record");
  if (typeof r.userId !== "string" || !/^[a-z0-9]{8,40}$/i.test(r.userId)) throw new Error("record has no valid userId");
  if (typeof r.email !== "string" || !isSyntheticEmailAllowed(r.email)) throw new Error("record email is not an @example.test address");
  if (r.env !== "local" && r.env !== "preview") throw new Error("record env is not local/preview");
  if (r.targetHash !== null && typeof r.targetHash !== "string") throw new Error("record targetHash invalid");
  return r as SyntheticRecord;
}

export interface CleanupCounts { users: number; grants: number; conversations: number; messages: number; sessions: number }

export function cleanupCountsRecord(env: string, before: CleanupCounts, after: CleanupCounts, at: Date) {
  const removed = (k: keyof CleanupCounts) => Math.max(0, before[k] - after[k]);
  return {
    kind: "synthetic-operator-cleanup" as const,
    env,
    at: at.toISOString(),
    removed: {
      users: removed("users"), grants: removed("grants"), conversations: removed("conversations"),
      messages: removed("messages"), sessions: removed("sessions"),
    },
    remaining: { ...after },
  };
}

// ── Cleanup provider-connection guard ────────────────────────────────────────

/** The only PlaidItem status that does NOT block cleanup. */
export const CLEANUP_IGNORED_ITEM_STATUS = "REVOKED" as const satisfies PlaidItemStatus;

/**
 * True when the synthetic operator's PlaidItem statuses must refuse cleanup.
 * REVOKED (disconnected) items are removed by the user purge's cascade
 * (PlaidItem.user onDelete: Cascade), and purgeUser only calls Plaid itemRemove
 * for ACTIVE items (lib/account-deletion/purge.ts), so the script's throwing
 * itemRemove stub stays unreachable. ACTIVE, ERROR or any other non-REVOKED
 * item still refuses.
 */
export function providerConnectionBlocksCleanup(statuses: readonly PlaidItemStatus[]): boolean {
  return statuses.some((s) => s !== CLEANUP_IGNORED_ITEM_STATUS);
}

// ══ PROFILE e0-live (S2 ruling R-1; E0-LIVE design §5.2) ═════════════════════
//
// Opt-in only (`--profile=e0-live`). Nothing above changes for the default
// profile: SYNTHETIC_GRANTS, FORBIDDEN_AREAS and isGrantAllowed still refuse
// CUSTOMER_SUCCESS, and the default gate refuses every e0-live-only flag.

export const E0_LIVE_PROFILE = "e0-live" as const;

export type E0LiveRole = "ops" | "cs1" | "cs2" | "cs3" | "rev";
export type E0LiveArea = "PLATFORM_OPS" | "CUSTOMER_SUCCESS";

/** Areas no profile may ever grant (SYSTEM_ADMIN is a role and is never written: SYNTHETIC_ROLE). */
export const ALWAYS_FORBIDDEN_AREAS: ReadonlySet<string> = new Set(["MERCHANT_OPS", "SECURITY_OPS"]);
/** The ONLY areas the e0-live profile may grant. */
export const E0_LIVE_AREAS: ReadonlySet<string> = new Set(["PLATFORM_OPS", "CUSTOMER_SUCCESS"]);

export interface E0LiveOperator {
  role: E0LiveRole;
  email: string;
  username: string;
  firstName: string;
  lastName: string;
  grants: ReadonlyArray<Readonly<{ area: E0LiveArea; level: SyntheticLevel }>>;
}

const e0Grant = (area: E0LiveArea) => Object.freeze({ area, level: "READ" as const });
const e0Op = (role: E0LiveRole, lastName: string, grants: E0LiveArea[]): E0LiveOperator => Object.freeze({
  role,
  email: `e0l-${role}${SYNTHETIC_EMAIL_DOMAIN}`,
  username: `e0l_${role}`,
  firstName: "E0L",
  lastName,
  grants: Object.freeze(grants.map(e0Grant)),
});

/** EXACTLY this roster, nothing else (S2 R-1: capped at ops, cs1–cs3, rev). Pinned by the test. */
export const E0_LIVE_ROSTER: ReadonlyArray<E0LiveOperator> = Object.freeze([
  e0Op("ops", "Ops", ["PLATFORM_OPS"]),
  e0Op("cs1", "Cs One", ["CUSTOMER_SUCCESS"]),
  e0Op("cs2", "Cs Two", ["CUSTOMER_SUCCESS"]),
  e0Op("cs3", "Cs Three", ["CUSTOMER_SUCCESS"]),
  e0Op("rev", "Rev", ["PLATFORM_OPS", "CUSTOMER_SUCCESS"]),
]);

/** The ONLY operator --revoke-area / --regrant-area may act on. */
export const E0_LIVE_FLIP_OPERATOR = "rev" as const;

export function e0LiveOperator(role: string): E0LiveOperator | null {
  return E0_LIVE_ROSTER.find((o) => o.role === role) ?? null;
}

/** True only for (area, level) inside the e0-live profile's area set, READ, never always-forbidden. */
export function isE0LiveGrantAllowed(area: string, level: string): boolean {
  if (ALWAYS_FORBIDDEN_AREAS.has(area) || !ALLOWED_LEVELS.has(level)) return false;
  return E0_LIVE_AREAS.has(area);
}

/** True only when `role` is in the roster AND (area, level) is one of that operator's own grants. */
export function isRosterGrant(role: string, area: string, level: string): boolean {
  const o = e0LiveOperator(role);
  return !!o && isE0LiveGrantAllowed(area, level) && o.grants.some((x) => x.area === area && x.level === level);
}

/** The areas --revoke-area / --regrant-area accept: the `rev` operator's own grants only. */
export function isE0LiveFlipArea(area: string): area is E0LiveArea {
  return isRosterGrant(E0_LIVE_FLIP_OPERATOR, area, "READ");
}

/** Same-day deadline: the provision UTC day at 23:59:59Z (S2 R-1). */
export function computeE0LiveDeadline(provisionedAt: Date): Date {
  const d = new Date(provisionedAt.getTime());
  d.setUTCHours(23, 59, 59, 0);
  return d;
}

// ── Private location (one 0700 dir; one 0700 sub-dir per operator) ───────────

export const E0_LIVE_DIR_PREFIX = "synthetic-operator-e0l-";
const E0_LIVE_DIR_NAME = /^synthetic-operator-e0l-\d{8}T\d{6}Z$/;

export function e0LiveDirFor(privateBase: string, at: Date): string {
  return path.join(privateBase, `${E0_LIVE_DIR_PREFIX}${utcStamp(at)}`);
}
export function e0LiveOperatorDir(rosterDir: string, role: E0LiveRole): string {
  return path.join(rosterDir, role);
}

/** --record (e0-live) must name a synthetic-operator-e0l-<stamp> directory directly inside the private base. */
export function e0LiveRecordDirRefusal(recordDir: string, privateBase: string): string | null {
  const abs = path.resolve(recordDir);
  const base = path.resolve(privateBase);
  if (path.dirname(abs) !== base || !E0_LIVE_DIR_NAME.test(path.basename(abs))) {
    return "--record must be a synthetic-operator-e0l-<UTC stamp> directory directly inside the private evidence base.";
  }
  return null;
}

// ── Gate ─────────────────────────────────────────────────────────────────────

function decideE0Live(args: readonly string[], env: NodeJS.ProcessEnv): SyntheticDecision {
  const refuse = (...reasons: string[]): SyntheticDecision => ({ ok: false, reasons });

  const envFlag = flagValue(args, "env");
  if (envFlag === undefined || envFlag === "") return refuse("exactly one --env=preview is required.");
  if (envFlag === "production") return refuse("--env=production is refused: the e0-live roster is Preview-only.");
  if (envFlag !== "preview") return refuse("--profile=e0-live is Preview-only: --env must be exactly `preview`.");

  const provision = flagValue(args, "provision");
  const revoke = flagValue(args, "revoke-area");
  const regrant = flagValue(args, "regrant-area");
  const cleanup = flagValue(args, "cleanup");
  const record = flagValue(args, "record");
  const operator = flagValue(args, "operator");
  const awaitSignal = flagValue(args, "await-signal");

  const commands = [provision, revoke, regrant, cleanup].filter((v) => v !== undefined).length;
  if (commands !== 1) return refuse("exactly one of --provision, --revoke-area=<AREA>, --regrant-area=<AREA>, --cleanup is required.");
  if (provision !== undefined && provision !== "") return refuse("--provision takes no value.");
  if (cleanup !== undefined && cleanup !== "") return refuse("--cleanup takes no value.");
  if (awaitSignal !== undefined && awaitSignal !== "") return refuse("--await-signal takes no value.");
  if (record !== undefined && cleanup === undefined) return refuse("--record applies only to --cleanup.");
  if (awaitSignal !== undefined && revoke === undefined) return refuse("--await-signal applies only to --revoke-area.");
  const flip = revoke !== undefined || regrant !== undefined;
  if (operator !== undefined && !flip) return refuse("--operator applies only to --revoke-area / --regrant-area.");

  let command: E0LiveCommand;
  if (provision !== undefined) {
    command = { kind: "provision" };
  } else if (flip) {
    if (operator !== E0_LIVE_FLIP_OPERATOR) {
      return refuse(`--revoke-area / --regrant-area require --operator=${E0_LIVE_FLIP_OPERATOR} and act on no other operator.`);
    }
    const area = (revoke ?? regrant) as string;
    if (!area || !isE0LiveFlipArea(area)) {
      return refuse("the area must be one of the rev operator's own grants (PLATFORM_OPS or CUSTOMER_SUCCESS).");
    }
    command = revoke !== undefined
      ? { kind: "revoke-area", area, operator: E0_LIVE_FLIP_OPERATOR, awaitSignal: awaitSignal !== undefined }
      : { kind: "regrant-area", area, operator: E0_LIVE_FLIP_OPERATOR };
  } else {
    if (!record) return refuse("--cleanup requires --record=<path to the private synthetic-operator-e0l directory>.");
    command = { kind: "cleanup", recordDir: record };
  }

  const gate = decideRepairEnvGuard({
    apply: true, envFlag, databaseUrl: env.DATABASE_URL, directUrl: env.DIRECT_URL,
    productionRef: env.FM_PRODUCTION_DB_REF, vercelEnv: env.VERCEL_ENV, env,
  });
  if (!gate.ok) return refuse(...gate.reasons);
  if (gate.env !== "preview") return refuse("the environment could not be proven to be Preview.");
  return { ok: true, profile: "e0-live", env: "preview", targetHash: gate.targetHash, command };
}

// ── Records ──────────────────────────────────────────────────────────────────

export interface E0LiveRecord {
  kind: "synthetic-operator-e0l-record";
  profile: typeof E0_LIVE_PROFILE;
  role: E0LiveRole;
  env: "preview";
  targetHash: string | null;
  email: string;
  userId: string;
  grantIds: Record<string, string>;
  provisionedAt: string;
  cleanupDeadline: string;
}

/** Parse one operator's record and bind it to the roster entry for `role` (email must match exactly). */
export function parseE0LiveRecord(raw: unknown, role: E0LiveRole): E0LiveRecord {
  const r = raw as Partial<E0LiveRecord> | null;
  if (!r || r.kind !== "synthetic-operator-e0l-record" || r.profile !== E0_LIVE_PROFILE) throw new Error("not an e0-live operator record");
  const o = e0LiveOperator(role);
  if (!o || r.role !== role) throw new Error("record role is not the expected roster role");
  if (typeof r.userId !== "string" || !/^[a-z0-9]{8,40}$/i.test(r.userId)) throw new Error("record has no valid userId");
  if (r.email !== o.email || !isSyntheticEmailAllowed(r.email)) throw new Error("record email is not the roster address for its role");
  if (r.env !== "preview") throw new Error("record env is not preview");
  if (r.targetHash !== null && typeof r.targetHash !== "string") throw new Error("record targetHash invalid");
  return r as E0LiveRecord;
}

// ── Revoke / regrant ─────────────────────────────────────────────────────────

/** The exact line the runner writes on stdin to release an --await-signal revoke. */
export const AWAIT_SIGNAL_GO = "REVOKE";
/** How long an --await-signal revoker waits before giving up WITHOUT changing anything. */
export const AWAIT_SIGNAL_MAX_MS = 15 * 60 * 1000;

/** "go" only for exactly AWAIT_SIGNAL_GO (surrounding whitespace ignored); anything else aborts. */
export function classifySignalLine(line: string): "go" | "abort" {
  return typeof line === "string" && line.trim() === AWAIT_SIGNAL_GO ? "go" : "abort";
}

/**
 * The audit action a regrant writes — the SAME classification the app's grant
 * route makes (app/api/admin/platform-grants/route.ts): no row ⇒ CREATED; a
 * REVOKED row ⇒ REINSTATED (PlatformGrant is @@unique([userId, area]), so a
 * revoked row is reinstated, never re-created). An ACTIVE row is refused (a
 * regrant must follow a revoke) rather than a silent no-op.
 */
export function regrantAuditAction(existing: { status: string } | null): "PLATFORM_GRANT_CREATED" | "PLATFORM_GRANT_REINSTATED" | null {
  if (!existing) return "PLATFORM_GRANT_CREATED";
  if (existing.status === "REVOKED") return "PLATFORM_GRANT_REINSTATED";
  return null;
}
