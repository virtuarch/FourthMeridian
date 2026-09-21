/**
 * scripts/lib/db-guard.core.ts — the PURE decision behind scripts/db-guard.ts.
 *
 * ── 2026-09-15 — WHY `migrate dev` IS A DESTRUCTIVE COMMAND ────────────────
 * `prisma migrate dev`, run from a non-interactive shell against a database
 * with schema drift (or a failed/pending hand-written migration), RESET the
 * populated development database BEFORE Prisma's own "environment is
 * non-interactive, which is not supported" refusal printed. Every table read
 * zero rows; the newest backup was 19 days old. The guard used to wrap only
 * `db:reset`; `db:migrate` was a bare `prisma migrate dev`, so nothing stood
 * between an automated session and the reset.
 *
 * ── 2026-09-21 — THE GUARD MUST CHECK THE DATABASE PRISMA WILL MUTATE ──────
 * The pre-S1 audit (FM-AUDIT-002) found this decision — and the backup after it
 * — reading DATABASE_URL while Prisma Migrate connects through DIRECT_URL. With
 * the two split, the guard approved and backed up one database and Prisma reset
 * the other. Every mode now starts from `mutationAuthority`
 * (lib/db/target-identity.ts): the target is resolved as Prisma resolves it, the
 * two URLs must be provably one logical database, and a shadow URL must be
 * provably distinct. FM-AUDIT-032: `reset` of anything that is not a recognised
 * clone additionally needs a human at a TTY typing the exact `host/database`;
 * the env flag alone may be left exported from an earlier command.
 *
 * The decision is pure so each incident is pinned by a unit test, and the
 * refusal happens in this process, before Prisma is spawned.
 */

import { mutationAuthority, type MutationTarget } from "@/lib/db/target-identity";

export type DbGuardMode = "reset" | "migrate-dev" | "migrate-deploy";

export interface DbGuardInput {
  mode: DbGuardMode;
  dbUrl: string | undefined;
  /** `process.env.DIRECT_URL` — Prisma Migrate's connection when set. */
  directUrl: string | undefined;
  shadowUrl: string | undefined;
  /** schema.prisma declares `directUrl = env("DIRECT_URL")`. */
  requireDirect: boolean;
  /** `FM_DB_GUARD=clone-only` is in force. */
  armed: boolean;
  /** `process.env.ALLOW_DESTRUCTIVE_DB`, verbatim. */
  allowDestructive: string | undefined;
  /** stdin AND stdout are TTYs — a human can answer a prompt. */
  interactive: boolean;
  /**
   * Does the mutation target hold rows? `null` = could not be determined
   * (unreachable, no client) and is treated as POPULATED: an unknown database
   * is never a safe thing to reset.
   */
  populated: boolean | null;
  /** What a human typed when asked to confirm a reset of a non-clone target. */
  typedConfirmation: string | null;
}

export interface DbGuardDecision {
  ok: boolean;
  /** Why it was refused, first line first. Empty when ok. */
  reasons: string[];
  /** What to do instead. Empty when ok. */
  hint: string[];
  /** The database the command will mutate, when it could be identified. */
  target?: MutationTarget;
}

/** `host[:port]/database`, never credentials. */
export function describeTarget(url: string | undefined): string {
  if (!url) return "(unset)";
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`;
  } catch {
    return "(unparseable)";
  }
}

/**
 * Reset needs a typed confirmation when the target is not a recognised clone.
 * The script asks for it only when this says so (and only at a TTY).
 */
export function resetNeedsTypedConfirmation(target: MutationTarget): boolean {
  return target.verdict !== "NON_LIVE";
}

export function decideDbGuard(i: DbGuardInput): DbGuardDecision {
  const authority = mutationAuthority(
    { DATABASE_URL: i.dbUrl, DIRECT_URL: i.directUrl, SHADOW_DATABASE_URL: i.shadowUrl },
    { requireDirect: i.requireDirect, armed: i.armed },
  );
  if (!authority.ok) return { ok: false, reasons: authority.reasons, hint: authority.hint };
  const target = authority.target;
  const where = target.identity.display;

  if (i.mode === "migrate-deploy") {
    // Additive (applies committed migrations). The authority check above is the whole gate.
    return { ok: true, reasons: [], hint: [], target };
  }

  if (i.mode === "migrate-dev") {
    const populated = i.populated !== false; // unknown ⇒ populated (fail closed)
    if (populated && !i.interactive) {
      return {
        ok: false,
        target,
        reasons: [
          `\`prisma migrate dev\` refused: non-interactive shell against a ${i.populated === null ? "database of UNKNOWN contents" : "POPULATED database"} (${where}).`,
          "When migrate dev meets schema drift or a failed migration it RESETS the",
          "database, and in a non-interactive shell it did so on 2026-09-15 BEFORE its",
          "own 'non-interactive is not supported' refusal appeared. ~3 weeks of data lost.",
        ],
        hint: [
          "To APPLY a migration you already wrote:   npm run db:migrate:safe   (guard + backup + migrate deploy, additive)",
          "To CREATE a migration interactively:     run `npm run db:migrate` from a real terminal (TTY),",
          "                                          answer Prisma's prompt yourself; a backup is taken first.",
          "Never run `npx prisma migrate dev` directly from a script or an agent session.",
        ],
      };
    }
    return { ok: true, reasons: [], hint: [], target };
  }

  // reset: explicit opt-in, then — for anything that is not a clone — a human
  // proving at a terminal that they know which database they are aimed at.
  if (i.allowDestructive !== "true") {
    return {
      ok: false,
      target,
      reasons: [
        `This would RESET (drop every table, re-migrate, re-seed):  ${where}`,
        "That database may contain REAL personal test data (Plaid connections,",
        "sync history, manually created Spaces) — none of which is in the seed.",
      ],
      hint: [
        "If you truly intend this:",
        "  ALLOW_DESTRUCTIVE_DB=true npm run db:reset     (a backup of this same database is taken first)",
      ],
    };
  }
  if (resetNeedsTypedConfirmation(target)) {
    if (!i.interactive) {
      return {
        ok: false,
        target,
        reasons: [
          `${where} is not a recognised clone (${target.verdict}). Resetting it needs a typed confirmation`,
          "at a real terminal — the ALLOW_DESTRUCTIVE_DB flag alone may be left exported from an earlier",
          "command, and this shell is not interactive.",
        ],
        hint: [
          "Reset a clone instead (`fintracker_<suffix>` on BOTH DATABASE_URL and DIRECT_URL), or run",
          "`ALLOW_DESTRUCTIVE_DB=true npm run db:reset` from a real terminal and type the target when asked.",
        ],
      };
    }
    if (i.typedConfirmation !== where) {
      return {
        ok: false,
        target,
        reasons: [`Confirmation did not match. Expected exactly:  ${where}`],
        hint: ["Nothing was changed."],
      };
    }
  }
  return { ok: true, reasons: [], hint: [], target };
}
