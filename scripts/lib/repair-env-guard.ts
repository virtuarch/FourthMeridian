/**
 * scripts/lib/repair-env-guard.ts — the PURE environment gate for historical
 * repair scripts that WRITE (first user: scripts/repair-transfer-debt-payment.ts).
 *
 * ── The rule ────────────────────────────────────────────────────────────────
 *
 * A DRY RUN reads and is always allowed. An APPLY must name its environment and
 * the connection must PROVE it is that environment and not Production:
 *
 *   --env=local    the target is a loopback host (lib/db/target-identity "local").
 *   --env=preview  the target is a Supabase project (direct host or pooler user)
 *                  whose project ref is NOT the Production ref. The Production
 *                  ref is not in the repository (it is an operator fact), so it
 *                  must be supplied in FM_PRODUCTION_DB_REF — and when it is not,
 *                  the gate REFUSES: "I cannot tell" is not "it is not Production".
 *   anything else  refused — including no --env at all, and --env=production.
 *
 * Plus, for every apply:
 *   · VERCEL_ENV=production refuses outright.
 *   · DATABASE_URL and DIRECT_URL, when both are set, must be provably ONE logical
 *     database (`targetRelationship` === SAME) — the FM-AUDIT-002 class: never
 *     check A and write B.
 *   · FM_DB_GUARD=clone-only, when armed, keeps its meaning (`urlDatabaseRefusal`).
 *
 * ⚠️ PURE and SECRET-FREE. It never returns or prints a URL, a host, a user or a
 * password; refusals name the RULE, never the value. The repair prints only the
 * env label and the verdict.
 */

import { databaseIdentity, targetRelationship } from "@/lib/db/target-identity";
import { urlDatabaseRefusal } from "@/lib/db/live-guard";

export type RepairEnv = "local" | "preview";

export interface RepairEnvGuardInput {
  apply: boolean;
  /** The raw `--env=` value, or null when absent. */
  envFlag: string | null;
  databaseUrl: string | undefined;
  directUrl: string | undefined;
  /** FM_PRODUCTION_DB_REF — the Production Supabase project ref. Never printed. */
  productionRef: string | undefined;
  vercelEnv: string | undefined;
  /** The process env, for the FM_DB_GUARD clone-only check. */
  env: NodeJS.ProcessEnv;
}

export interface RepairEnvGuardDecision {
  ok: boolean;
  mode: "DRY_RUN" | "APPLY";
  env: RepairEnv | null;
  /** Why it was refused. Never contains a URL, host, user or secret. */
  reasons: string[];
}

const SUPABASE_KEY = /^supabase:([a-z0-9]+)\//;

export function decideRepairEnvGuard(i: RepairEnvGuardInput): RepairEnvGuardDecision {
  const env = i.envFlag === "local" || i.envFlag === "preview" ? i.envFlag : null;
  if (!i.apply) return { ok: true, mode: "DRY_RUN", env, reasons: [] };

  const refuse = (...reasons: string[]): RepairEnvGuardDecision => ({ ok: false, mode: "APPLY", env, reasons });

  if (env === null) {
    return refuse(
      i.envFlag == null
        ? "--apply requires an explicit --env=preview or --env=local."
        : "--env must be exactly `preview` or `local`; this repair is never applied to any other environment.",
    );
  }
  if ((i.vercelEnv ?? "").toLowerCase() === "production") {
    return refuse("VERCEL_ENV is production — this repair is not authorized there.");
  }

  const url = i.databaseUrl;
  const id = databaseIdentity(url);
  if (!id) return refuse("DATABASE_URL is unset or unparseable, so the target cannot be identified.");
  if (i.directUrl && targetRelationship(url, i.directUrl) !== "SAME") {
    return refuse("DATABASE_URL and DIRECT_URL are not provably the same database — refusing to check one and write the other.");
  }
  const armed = urlDatabaseRefusal(url, i.env);
  if (armed) return refuse("FM_DB_GUARD=clone-only is armed and the target is not a clone.");

  if (env === "local") {
    return id.family === "local"
      ? { ok: true, mode: "APPLY", env, reasons: [] }
      : refuse("--env=local requires a loopback database host.");
  }

  // preview
  const ref = SUPABASE_KEY.exec(id.key)?.[1] ?? null;
  if (!ref) return refuse("--env=preview requires a Supabase target (direct host or pooler user) whose project can be identified.");
  const prod = (i.productionRef ?? "").trim().toLowerCase();
  if (prod === "") {
    return refuse("FM_PRODUCTION_DB_REF is not set, so the target cannot be proven to be outside the Production project.");
  }
  if (ref === prod) return refuse("The target IS the Production project. This repair is not authorized for Production.");
  return { ok: true, mode: "APPLY", env, reasons: [] };
}
