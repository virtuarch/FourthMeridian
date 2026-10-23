/**
 * lib/security/cron-secret.ts — SEC-009: constant-time comparison of the
 * CRON_SECRET bearer.
 *
 * Six job routes compare `Authorization: Bearer <secret>` with `!==`, which
 * short-circuits on the first differing byte (CWE-208). The helper below is the
 * one comparison to adopt: it hashes both sides to a fixed length and compares
 * with crypto.timingSafeEqual, so neither the secret's length nor its prefix
 * leaks through timing. app/api/jobs/** is owned by Agent C; this module ships
 * the helper and its tests so adoption is a one-line change per route:
 *
 *   const verdict = verifyCronAuthorization(req.headers.get("authorization"), process.env.CRON_SECRET);
 *   if (verdict !== "AUTHORIZED") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
 *
 * Pure: node:crypto only.
 */

import { createHash, timingSafeEqual } from "node:crypto";

/** Constant-time string equality; false for a non-string or an empty expected value. */
export function timingSafeStringEqual(actual: unknown, expected: unknown): boolean {
  if (typeof actual !== "string" || typeof expected !== "string") return false;
  if (expected.length === 0) return false;
  // Hash to a fixed width so lengths never short-circuit and never leak.
  const a = createHash("sha256").update(actual, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

export type CronAuthVerdict =
  | "AUTHORIZED"
  /** CRON_SECRET is not configured — the route must refuse, never run open. */
  | "SECRET_UNSET"
  /** No `Authorization: Bearer …` header. */
  | "MISSING"
  /** The bearer did not match. */
  | "MISMATCH";

/**
 * Verify a cron request's bearer against the configured secret, in constant
 * time. An unset secret is a refusal (SECRET_UNSET), not an open door.
 */
export function verifyCronAuthorization(
  authorizationHeader: string | null | undefined,
  cronSecret: string | undefined,
): CronAuthVerdict {
  if (!cronSecret) return "SECRET_UNSET";
  if (typeof authorizationHeader !== "string") return "MISSING";
  const m = /^Bearer\s+(.+)$/i.exec(authorizationHeader.trim());
  if (!m) return "MISSING";
  return timingSafeStringEqual(m[1], cronSecret) ? "AUTHORIZED" : "MISMATCH";
}
