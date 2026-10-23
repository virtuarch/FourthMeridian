/**
 * lib/db/target-identity.ts — FM-AUDIT-002 / FM-AUDIT-032
 *
 * WHICH DATABASE WILL A DESTRUCTIVE COMMAND ACTUALLY MUTATE — AND IS IT THE ONE
 * THAT WAS CHECKED AND BACKED UP?
 *
 * ── THE DEFECT THIS CLOSES ──────────────────────────────────────────────────
 * `prisma/schema.prisma` declares `directUrl = env("DIRECT_URL")`. Prisma
 * Migrate (`migrate dev`, `migrate reset`, `migrate deploy`) connects through
 * DIRECT_URL whenever it is set. Before this module, `scripts/db-guard.ts`
 * classified, population-probed and `scripts/db-backup.ts` dumped DATABASE_URL —
 * so an environment with DATABASE_URL on a clone and DIRECT_URL still on
 * `fintracker` (the documented clone recipe rewrote DATABASE_URL only) would pass
 * the guard, back up the CLONE, and reset LIVE: the 2026-09-15 incident class,
 * reachable through a supported command.
 *
 * ── THE INVARIANT ───────────────────────────────────────────────────────────
 * A supported repository command never validates or backs up database A and then
 * mutates database B. Every guard, probe and backup resolves the mutation target
 * the way Prisma does (`DIRECT_URL ?? DATABASE_URL`), and when both URLs are set
 * they must be PROVABLY the same logical database — or the command refuses.
 *
 * ── LOGICAL IDENTITY, NOT STRING EQUALITY ───────────────────────────────────
 * The two URLs legitimately differ in production: DATABASE_URL is Supabase's
 * transaction pooler (port 6543, user `postgres.<ref>`), DIRECT_URL the direct
 * host `db.<ref>.supabase.co`. So identity is:
 *   · local   — a loopback host (localhost / 127.0.0.1 / ::1): port + database.
 *   · supabase — the project ref (from `db.<ref>.supabase.co`, or the pooler
 *                user `postgres.<ref>` on `*.pooler.supabase.com`) + database.
 *   · host    — anything else: exact host + port + database.
 * SAME only when the keys are equal. Anything not provably the same — including
 * two unknown hosts that might be a pooler and its primary — is UNPROVABLE, and
 * UNPROVABLE refuses. Fail closed on ambiguity.
 *
 * ⚠️ PURE. No I/O, no Prisma. Credentials never leave this module: only
 * `host[:port]/database` is ever rendered.
 */

import { classifyDatabaseTarget, dbGuardArmed, type DatabaseVerdict } from "@/lib/db/live-guard";

export type IdentityFamily = "local" | "supabase" | "host";

export interface DatabaseIdentity {
  family: IdentityFamily;
  /** Equal keys ⇔ the same logical database. */
  key: string;
  database: string;
  /** `host[:port]/database` — safe to print. */
  display: string;
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"]);
const SUPABASE_DIRECT = /^db\.([a-z0-9]{15,40})\.supabase\.co$/;
const SUPABASE_POOLER_HOST = /\.pooler\.supabase\.com$/;
const SUPABASE_POOLER_USER = /^[^.]+\.([a-z0-9]{15,40})$/;

export function databaseIdentity(url: string | undefined | null): DatabaseIdentity | null {
  if (typeof url !== "string" || url.trim() === "") return null;
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (!/^postgres(ql)?:$/.test(u.protocol)) return null;
  const database = decodeURIComponent(u.pathname.replace(/^\//, ""));
  if (database === "") return null;
  const host = u.hostname.toLowerCase();
  const port = u.port || "5432";
  const display = `${u.host}/${database}`;

  if (LOOPBACK.has(host)) return { family: "local", key: `local:${port}/${database}`, database, display };
  const direct = SUPABASE_DIRECT.exec(host);
  if (direct) return { family: "supabase", key: `supabase:${direct[1]}/${database}`, database, display };
  if (SUPABASE_POOLER_HOST.test(host)) {
    const ref = SUPABASE_POOLER_USER.exec(decodeURIComponent(u.username));
    if (ref) return { family: "supabase", key: `supabase:${ref[1]}/${database}`, database, display };
  }
  return { family: "host", key: `host:${host}:${port}/${database}`, database, display };
}

export type TargetRelationship = "SAME" | "DIFFERENT" | "UNPROVABLE";

/** Are these two connection strings the same logical database? */
export function targetRelationship(a: string | undefined | null, b: string | undefined | null): TargetRelationship {
  const x = databaseIdentity(a), y = databaseIdentity(b);
  if (!x || !y) return "UNPROVABLE";
  if (x.key === y.key) return "SAME";
  if (x.database !== y.database) return "DIFFERENT";
  if (x.family === y.family && x.family !== "host") return "DIFFERENT"; // other port / other project
  return "UNPROVABLE";
}

export interface MutationEnv {
  DATABASE_URL?: string;
  DIRECT_URL?: string;
  SHADOW_DATABASE_URL?: string;
}

export interface MutationTarget {
  /** The URL Prisma Migrate will connect to — and the one to back up and probe. */
  url: string;
  /** Which variable it came from. */
  source: "DIRECT_URL" | "DATABASE_URL";
  identity: DatabaseIdentity;
  verdict: DatabaseVerdict;
}

export type MutationAuthority =
  | { ok: true; target: MutationTarget }
  | { ok: false; reasons: string[]; hint: string[] };

export interface MutationAuthorityOptions {
  /** schema.prisma declares `directUrl = env("DIRECT_URL")`, so Prisma needs it set. */
  requireDirect: boolean;
  /** `FM_DB_GUARD=clone-only` in force: the target must be a clone. */
  armed?: boolean;
}

const display = (url: string | undefined) => databaseIdentity(url)?.display ?? "(unparseable)";
const SET_BOTH = [
  "Point EVERY mutation-capable URL at the database you intend — for a clone:",
  "  DATABASE_URL=…/fintracker_<suffix>  DIRECT_URL=…/fintracker_<suffix>",
  "(An EXPORTED variable beats --env-file; check `printenv DATABASE_URL DIRECT_URL`.)",
];

/**
 * The database a destructive or schema-mutating command would change, proven to
 * be the one every check and backup in the same command sees — or a refusal.
 */
export function mutationAuthority(env: MutationEnv, opts: MutationAuthorityOptions): MutationAuthority {
  const runtime = env.DATABASE_URL?.trim() || undefined;
  const direct = env.DIRECT_URL?.trim() || undefined;
  const shadow = env.SHADOW_DATABASE_URL?.trim() || undefined;

  if (!runtime || !databaseIdentity(runtime)) {
    return { ok: false, reasons: ["DATABASE_URL is unset or not a parseable postgres URL, so the target cannot be identified."], hint: SET_BOTH };
  }
  if (opts.requireDirect && !direct) {
    return {
      ok: false,
      reasons: [
        "DIRECT_URL is unset. prisma/schema.prisma declares `directUrl = env(\"DIRECT_URL\")`, and Prisma",
        "Migrate connects through it — so the mutation target cannot be proven to be DATABASE_URL's",
        `(${display(runtime)}).`,
      ],
      hint: SET_BOTH,
    };
  }
  if (direct) {
    if (!databaseIdentity(direct)) {
      return { ok: false, reasons: ["DIRECT_URL is set but is not a parseable postgres URL."], hint: SET_BOTH };
    }
    const rel = targetRelationship(runtime, direct);
    if (rel !== "SAME") {
      return {
        ok: false,
        reasons: [
          rel === "DIFFERENT"
            ? "DATABASE_URL and DIRECT_URL name DIFFERENT databases:"
            : "DATABASE_URL and DIRECT_URL cannot be PROVEN to be the same database:",
          `  DATABASE_URL → ${display(runtime)}   (checked, probed and backed up)`,
          `  DIRECT_URL   → ${display(direct)}   (what Prisma Migrate would actually change)`,
          "A guard that approves one database while Prisma mutates the other is the 2026-09-15",
          "incident class. Refusing before anything is backed up or mutated.",
        ],
        hint: SET_BOTH,
      };
    }
  }

  const url = direct ?? runtime;
  const identity = databaseIdentity(url)!;

  if (shadow) {
    for (const [name, candidate] of [["DATABASE_URL", runtime], ["DIRECT_URL", direct]] as const) {
      if (!candidate) continue;
      const rel = targetRelationship(shadow, candidate);
      if (rel !== "DIFFERENT") {
        return {
          ok: false,
          reasons: [
            `SHADOW_DATABASE_URL ${rel === "SAME" ? "IS" : "cannot be proven distinct from"} ${name} (${display(candidate)}).`,
            "`prisma migrate diff/dev --shadow-database-url <db>` RESETS the shadow database.",
          ],
          hint: ["Point SHADOW_DATABASE_URL at a throwaway database (or unset it)."],
        };
      }
    }
  }

  const verdict = classifyDatabaseTarget(url).verdict;
  if (opts.armed && verdict !== "NON_LIVE") {
    return {
      ok: false,
      reasons: [`FM_DB_GUARD=clone-only is set, and the mutation target ${identity.display} is not a clone (${verdict}).`],
      hint: SET_BOTH,
    };
  }
  return { ok: true, target: { url, source: direct ? "DIRECT_URL" : "DATABASE_URL", identity, verdict } };
}

/** Does schema.prisma route Migrate through DIRECT_URL? (Read by the guard, not assumed.) */
export function schemaRequiresDirectUrl(schemaText: string): boolean {
  const block = /datasource\s+\w+\s*\{([\s\S]*?)\}/.exec(schemaText)?.[1] ?? "";
  return /^\s*directUrl\s*=\s*env\(\s*"DIRECT_URL"\s*\)/m.test(block);
}

/** Convenience for scripts: authority from the real process env. */
export function processMutationAuthority(requireDirect: boolean, env: NodeJS.ProcessEnv = process.env): MutationAuthority {
  return mutationAuthority(
    { DATABASE_URL: env.DATABASE_URL, DIRECT_URL: env.DIRECT_URL, SHADOW_DATABASE_URL: env.SHADOW_DATABASE_URL },
    { requireDirect, armed: dbGuardArmed(env) },
  );
}
