/**
 * lib/audit-scrub/email-metadata.ts  (PRIV-002 historical residue)
 *
 * Since the pre-beta remediation (commit fa5d401) audit writers store an e-mail
 * only as a digest (`emailHash`, `targetEmailHash` — lib/audit.ts auditEmailHash).
 * Rows written BEFORE that still carry the raw address under `email` or
 * `targetEmail`, and AuditLog.userId's SetNull on account deletion does not
 * remove it. This is the pure rewrite rule the owner-run scrub applies:
 *
 *   - `email: "<addr>"`       → `emailHash: sha256(lower(trim(addr)))`
 *   - `targetEmail: "<addr>"` → `targetEmailHash: …`
 *   - every other key, the row id and createdAt are untouched;
 *   - a value that is not a string containing "@" is left alone (not an address);
 *   - an existing digest key is never overwritten (a row that has both keeps its
 *     digest and loses only the raw key).
 *
 * Idempotent: a scrubbed row has no raw key, so a second run changes nothing.
 */
import { auditEmailHash } from "@/lib/audit";

export const RAW_EMAIL_KEYS = { email: "emailHash", targetEmail: "targetEmailHash" } as const;

export type ScrubDecision =
  | { kind: "skip" }
  | { kind: "rewrite"; metadata: Record<string, unknown>; removedKeys: string[] };

export function decideEmailScrub(metadata: unknown): ScrubDecision {
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) return { kind: "skip" };
  const src = metadata as Record<string, unknown>;
  const out: Record<string, unknown> = { ...src };
  const removed: string[] = [];
  for (const [raw, digest] of Object.entries(RAW_EMAIL_KEYS)) {
    const v = src[raw];
    if (typeof v !== "string" || !v.includes("@")) continue;
    delete out[raw];
    removed.push(raw);
    if (typeof src[digest] !== "string") out[digest] = auditEmailHash(v);
  }
  return removed.length ? { kind: "rewrite", metadata: out, removedKeys: removed } : { kind: "skip" };
}
