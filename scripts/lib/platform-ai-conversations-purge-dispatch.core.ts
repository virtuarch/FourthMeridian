/**
 * scripts/lib/platform-ai-conversations-purge-dispatch.core.ts — the PURE gate for
 * the manual Platform AI conversation purge dispatch.
 *
 * S2 REQUIRED 2 on #424 (docs/plans/PLATFORM-AI-CONVERSATIONS-DESIGN.md §13):
 * Preview NEVER runs crons, so the scheduled retention job never fires there.
 * While conversations are enabled on Preview, an operator runs THIS dispatch at
 * least daily. It runs the SAME rule the job runs (runPlatformAiConversationPurge
 * over the definer function fm_purge_platform_ai_conversations), once, audited
 * counts only.
 *
 * The rule, before any database contact:
 *   · exactly the flags below; anything else is refused rather than guessed;
 *   · --env=local or --env=preview, PROVEN by the connection through
 *     scripts/lib/repair-env-guard.ts (apply mode): preview ⇒ a Supabase target
 *     whose project ref is NOT FM_PRODUCTION_DB_REF (unset ref ⇒ refused);
 *     local ⇒ a loopback host; VERCEL_ENV=production refuses; DATABASE_URL and
 *     DIRECT_URL must be one database; FM_DB_GUARD=clone-only keeps its meaning;
 *   · --env=production is ALWAYS refused: Production runs the scheduled job
 *     (cron) and this dispatch is for environments without crons;
 *   · DATABASE_URL_SYSTEM — the fm_system login the purge actually runs as
 *     (lib/db systemDb) — when set must be provably the SAME logical database as
 *     DATABASE_URL, so the guard never checks one target and purges another.
 *
 * ⚠️ PURE and SECRET-FREE: refusals name the RULE, never a URL, host, user or ref.
 */

import { targetRelationship } from "@/lib/db/target-identity";
import { decideRepairEnvGuard } from "./repair-env-guard";

export const PURGE_DISPATCH_FLAGS = new Set(["env"]);

export type PurgeDispatchDecision =
  | { ok: true; env: "local" | "preview"; targetHash: string | null }
  | { ok: false; reasons: string[] };

export function decidePurgeDispatch(args: readonly string[], env: NodeJS.ProcessEnv): PurgeDispatchDecision {
  const refuse = (...reasons: string[]): PurgeDispatchDecision => ({ ok: false, reasons });
  const unknown = args.filter((a) => !a.startsWith("--") || !PURGE_DISPATCH_FLAGS.has(a.replace(/^--/, "").split("=")[0]));
  if (unknown.length) return refuse(`unknown argument(s): ${unknown.map((a) => a.split("=")[0]).join(", ")} — refusing rather than guessing.`);
  const envArgs = args.filter((a) => a.startsWith("--env="));
  if (envArgs.length !== 1) return refuse("exactly one --env=<local|preview> is required.");
  const envFlag = envArgs[0].slice("--env=".length);
  if (envFlag === "production") {
    return refuse("--env=production is refused: Production runs the scheduled data-retention job (cron); this dispatch exists for environments without crons (Preview, local).");
  }
  if (envFlag !== "local" && envFlag !== "preview") return refuse("--env must be exactly `local` or `preview`.");

  const gate = decideRepairEnvGuard({
    apply: true, envFlag, databaseUrl: env.DATABASE_URL, directUrl: env.DIRECT_URL,
    productionRef: env.FM_PRODUCTION_DB_REF, vercelEnv: env.VERCEL_ENV, env,
  });
  if (!gate.ok) return refuse(...gate.reasons);
  if (gate.env !== "local" && gate.env !== "preview") return refuse("the environment could not be proven non-Production.");
  if (env.DATABASE_URL_SYSTEM && targetRelationship(env.DATABASE_URL, env.DATABASE_URL_SYSTEM) !== "SAME") {
    return refuse("DATABASE_URL_SYSTEM (the fm_system login the purge runs as) is not provably the same database as DATABASE_URL — refusing to check one and purge the other.");
  }
  return { ok: true, env: gate.env, targetHash: gate.targetHash };
}
