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
 * ⚠️ PURE and SECRET-FREE: no database, no filesystem, no network. Refusals name
 * the RULE, never a URL, host, user, ref or secret.
 */

import path from "node:path";
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

export type SyntheticCommand =
  | { kind: "provision" }
  | { kind: "revoke-area"; area: SyntheticArea }
  | { kind: "cleanup"; recordDir: string };

export type SyntheticDecision =
  | { ok: true; env: "local" | "preview"; targetHash: string | null; command: SyntheticCommand }
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

  const unknown = args.filter((a) => !a.startsWith("--") || !SYNTHETIC_FLAGS.has(a.replace(/^--/, "").split("=")[0]));
  if (unknown.length) return refuse(`unknown argument(s): ${unknown.map((a) => a.split("=")[0]).join(", ")} — refusing rather than guessing.`);
  for (const name of SYNTHETIC_FLAGS) {
    if (flagValue(args, name) === null) return refuse(`--${name} given more than once.`);
  }

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
  return { ok: true, env: gate.env, targetHash: gate.targetHash, command };
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
