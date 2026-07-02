/**
 * scripts/backfill-ai-agents.ts
 *
 * One-time backfill: create an AiAgent row for every Space that does not
 * already have one. Safe to run multiple times — existing agents are never
 * touched.
 *
 * Background:
 *   AiAgent auto-creation was added as part of D4. Spaces created before that
 *   change have no agent row, causing buildContext() to throw. This script
 *   closes the gap without requiring a schema migration.
 *
 * Run:
 *   npx tsx scripts/backfill-ai-agents.ts
 *
 * Output:
 *   Spaces checked:   N
 *   Already had agent: N
 *   Agents created:   N
 */

import { PrismaClient } from "@prisma/client";

const db = new PrismaClient({ log: ["error", "warn"] });

async function main(): Promise<void> {
  // Fetch all non-deleted, non-archived Spaces with their existing agent.
  // Soft-deleted or archived Spaces are included intentionally — a user may
  // restore them, and an absent agent would cause the same error on restore.
  const spaces = await db.space.findMany({
    select: {
      id:       true,
      name:     true,
      aiAgent:  { select: { id: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  const total     = spaces.length;
  const missing   = spaces.filter((s) => s.aiAgent === null);
  const existing  = total - missing.length;

  console.log(`\nSpaces checked:    ${total}`);
  console.log(`Already had agent: ${existing}`);
  console.log(`Agents to create:  ${missing.length}\n`);

  if (missing.length === 0) {
    console.log("Nothing to do. ✓");
    return;
  }

  let created = 0;

  for (const space of missing) {
    await db.aiAgent.create({
      data: {
        spaceId:    space.id,
        name:       `${space.name} Agent`,
        agentScope: [],          // empty → full template manifest is used
      },
    });
    console.log(`  Created agent for Space "${space.name}" (${space.id})`);
    created++;
  }

  console.log(`\nAgents created: ${created} ✓`);
}

main()
  .catch((err) => {
    console.error("Backfill failed:", err);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
