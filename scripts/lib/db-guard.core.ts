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
 * The decision is pure so the exact incident can be pinned by a unit test:
 * non-interactive + populated (or UNKNOWN) database + migrate-dev ⇒ refused,
 * and the refusal happens in this process, before Prisma is spawned.
 */

export type DbGuardMode = "reset" | "migrate-dev";

export interface DbGuardInput {
  mode: DbGuardMode;
  dbUrl: string | undefined;
  shadowUrl: string | undefined;
  /** `process.env.ALLOW_DESTRUCTIVE_DB`, verbatim. */
  allowDestructive: string | undefined;
  /** stdin AND stdout are TTYs — a human can answer Prisma's prompt. */
  interactive: boolean;
  /**
   * Does the target database hold rows? `null` = could not be determined
   * (unreachable, no client) and is treated as POPULATED: an unknown database
   * is never a safe thing to reset.
   */
  populated: boolean | null;
}

export interface DbGuardDecision {
  ok: boolean;
  /** Why it was refused, first line first. Empty when ok. */
  reasons: string[];
  /** What to do instead. Empty when ok. */
  hint: string[];
}

export function describeTarget(url: string | undefined): string {
  if (!url) return "(unset)";
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`;
  } catch {
    return "(unparseable)";
  }
}

export function decideDbGuard(i: DbGuardInput): DbGuardDecision {
  const target = describeTarget(i.dbUrl);

  // Shadow-DB footgun — every mode. Using the live DB as a migrate shadow resets it.
  if (i.shadowUrl && i.dbUrl && i.shadowUrl.split("?")[0] === i.dbUrl.split("?")[0]) {
    return {
      ok: false,
      reasons: [
        "SHADOW_DATABASE_URL is the SAME as DATABASE_URL.",
        "`prisma migrate diff/dev --shadow-database-url <live-db>` RESETS that DB.",
        `Target: ${target}`,
      ],
      hint: ["Point SHADOW_DATABASE_URL at a throwaway database (or unset it)."],
    };
  }

  if (i.mode === "migrate-dev") {
    const populated = i.populated !== false; // unknown ⇒ populated (fail closed)
    if (populated && !i.interactive) {
      return {
        ok: false,
        reasons: [
          `\`prisma migrate dev\` refused: non-interactive shell against a ${i.populated === null ? "database of UNKNOWN contents" : "POPULATED database"} (${target}).`,
          "When migrate dev meets schema drift or a failed migration it RESETS the",
          "database, and in a non-interactive shell it did so on 2026-09-15 BEFORE its",
          "own 'non-interactive is not supported' refusal appeared. ~3 weeks of data lost.",
        ],
        hint: [
          "To APPLY a migration you already wrote:   npm run db:migrate:safe   (backup + migrate deploy, additive)",
          "To CREATE a migration interactively:     run `npm run db:migrate` from a real terminal (TTY),",
          "                                          answer Prisma's prompt yourself; a backup is taken first.",
          "Never run `npx prisma migrate dev` directly from a script or an agent session.",
        ],
      };
    }
    return { ok: true, reasons: [], hint: [] };
  }

  // reset (and any other destructive script): explicit opt-in, as before.
  if (i.allowDestructive !== "true") {
    return {
      ok: false,
      reasons: [
        `This would run a destructive command against:  ${target}`,
        "That database may contain REAL personal test data (Plaid connections,",
        "sync history, manually created Spaces) — none of which is in the seed.",
      ],
      hint: [
        "If you truly intend this:",
        "  1. Back up first:            npm run db:backup",
        "  2. Then re-run with opt-in:  ALLOW_DESTRUCTIVE_DB=true npm run <script>",
      ],
    };
  }
  return { ok: true, reasons: [], hint: [] };
}
