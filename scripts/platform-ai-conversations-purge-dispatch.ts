/**
 * scripts/platform-ai-conversations-purge-dispatch.ts — run the Platform AI
 * conversation retention purge ONCE, by hand (Preview / local only).
 *
 * S2 REQUIRED 2 on #424 (docs/plans/PLATFORM-AI-CONVERSATIONS-DESIGN.md §13).
 * Preview never runs crons, so the scheduled job (jobs/data-retention.ts) never
 * purges there. While PLATFORM_AI_CONVERSATIONS_ENABLED is on for Preview, an
 * operator runs this at least daily:
 *
 *   npm run ops:platform-ai-conversations-purge -- --env=preview
 *
 * It runs the job's OWN rule (platformAiPurgeDeps("MANUAL_DISPATCH") →
 * runPlatformAiConversationPurge → SELECT … fm_purge_platform_ai_conversations($1)
 * as fm_system): batch-bounded, fixed predicates, counts in and counts out. It
 * writes ONE AuditLog row PLATFORM_AI_CONVERSATIONS_PURGED every run (zero
 * included) — { conversations, messages, batches, exhausted, actorType: SYSTEM,
 * trigger: MANUAL_DISPATCH }, no userId, no content — and prints the same counts.
 *
 * Gates (before the first database contact): scripts/lib/
 * platform-ai-conversations-purge-dispatch.core.ts — --env=local|preview proven
 * by the connection; --env=production ALWAYS refused.
 *
 * Exit: 0 purged (or nothing to purge) · 3 the purge reported an error ·
 *       2 refused (nothing contacted) · 1 could not run.
 */

import { redactConnectionDetails } from "./lib/repair-env-guard";
import { decidePurgeDispatch } from "./lib/platform-ai-conversations-purge-dispatch.core";

async function main(): Promise<void> {
  const decision = decidePurgeDispatch(process.argv.slice(2), process.env);
  if (!decision.ok) {
    console.error("\n  REFUSED — nothing was contacted.");
    for (const r of decision.reasons) console.error(`    · ${r}`);
    console.error("");
    process.exit(2);
  }

  // Imported only after the gate: constructing a client is the first contact with any database.
  const { platformAiPurgeDeps } = await import("../jobs/data-retention");
  const { runPlatformAiConversationPurge } = await import("@/lib/platform/intelligence/ai/conversations/purge");
  const { db, systemDb } = await import("@/lib/db");
  try {
    const r = await runPlatformAiConversationPurge(await platformAiPurgeDeps("MANUAL_DISPATCH"));
    console.log(`\n  Platform AI conversations purge — manual dispatch (env=${decision.env}, target=${decision.targetHash ?? "unknown"}, at=${new Date().toISOString()})`);
    console.log(`    conversations removed: ${r.conversations}`);
    console.log(`    messages removed:      ${r.messages}`);
    console.log(`    batches:               ${r.batches}${r.exhausted ? "" : "  (more remain — run again)"}`);
    console.log(r.error ? `    RESULT: ERROR — ${r.error}\n` : "    RESULT: OK (one counts-only AuditLog row written)\n");
    process.exitCode = r.error ? 3 : 0;
  } finally {
    await (systemDb as unknown as { $disconnect(): Promise<void> }).$disconnect();
    await db.$disconnect();
  }
}

main().catch((e) => {
  console.error(redactConnectionDetails(e instanceof Error ? e.message : String(e), [process.env.FM_PRODUCTION_DB_REF]));
  process.exit(1);
});
