/**
 * scripts/seed-platform-spaces.ts  (PO1.0)
 *
 * Operator CLI over the idempotent platform-Space bootstrap
 * (lib/platform/seed.ts). Run once against prod after applying the PO1.0
 * migration; safe to re-run (the second run is a no-op — the upsert keys on the
 * Space.platformArea @unique marker).
 *
 *   npx tsx scripts/seed-platform-spaces.ts
 *
 * Requires DATABASE_URL. House pattern of scripts/check-job-health.ts: a thin
 * script over a library helper, no logic of its own.
 */

import { db } from "@/lib/db";
import { ensurePlatformSpaces, ensurePlatformSections } from "@/lib/platform/seed";
import { ALL_PLATFORM_AREAS } from "@/lib/platform/policy";

async function main(): Promise<void> {
  console.log("Ensuring platform Spaces (idempotent)…");
  await ensurePlatformSpaces(db);
  // Create-only backfill for sections added to PLATFORM_AREAS after a Space was
  // first seeded (the Space upsert's `update: {}` never adds them). Safe re-run.
  await ensurePlatformSections(db);

  const spaces = await db.space.findMany({
    where:   { platformArea: { not: null } },
    select:  { name: true, platformArea: true },
    orderBy: { platformArea: "asc" },
  });

  console.log(`\n${spaces.length} platform Space(s):`);
  for (const s of spaces) {
    console.log(`  ✓ ${s.platformArea?.padEnd(18)} → ${s.name}`);
  }

  if (spaces.length !== ALL_PLATFORM_AREAS.length) {
    console.error(
      `\nEXPECTED ${ALL_PLATFORM_AREAS.length} platform Spaces, found ${spaces.length}.`,
    );
    process.exit(1);
  }
  console.log("\nAll platform Spaces present.");
  process.exit(0);
}

main().catch((err) => {
  console.error("[seed-platform-spaces] failed:", err);
  process.exit(1);
});
