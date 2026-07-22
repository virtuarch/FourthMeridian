/**
 * scripts/backfill-personal-sections.ts
 *
 * SP-2A-3 backfill: ensure every Personal Space has the SpaceDashboardSection
 * rows of the hidden `personal` template (lib/space-templates, SP-1).
 *
 * Background:
 *   The register route never created dashboard sections for Personal Spaces
 *   (unlike POST /api/spaces, which materializes presets for every shared
 *   Space). SP-2A-3 fixes the source — registration now materializes the
 *   personal template — and this script closes the gap for Spaces that
 *   already exist. No schema migration is required or performed.
 *
 * Guarantees (mirrors the SP-1 planner's contract):
 *   - Idempotent: safe to run any number of times.
 *   - Additive only: existing rows are NEVER updated, deleted, or reordered;
 *     sections whose key already exists on a Space are skipped
 *     (planTemplateApplication + the @@unique([spaceId, key]) constraint).
 *   - Dry-run by default: pass --apply to write.
 *   - Logs aggregate counts only — no user financial data, no Space names.
 *
 * Run:
 *   npx tsx scripts/backfill-personal-sections.ts           # dry run
 *   npx tsx scripts/backfill-personal-sections.ts --apply   # write
 *
 * Output:
 *   Personal spaces scanned:   N
 *   Spaces needing sections:   N
 *   Sections planned:          N
 *   Sections created:          N   (only with --apply)
 */

import { PrismaClient, Prisma } from "@prisma/client";
import { getTemplateForCategory } from "../lib/space-templates/registry";
import { planTemplateApplication } from "../lib/space-templates/apply";

const APPLY = process.argv.includes("--apply");

const db = new PrismaClient({ log: ["error", "warn"] });

async function main(): Promise<void> {
  const personalTemplate = getTemplateForCategory("PERSONAL");
  if (!personalTemplate) {
    throw new Error("space-templates registry has no PERSONAL template");
  }

  // Include archived/trashed Spaces intentionally (a user may restore them),
  // same reasoning as backfill-ai-agents.ts.
  const spaces = await db.space.findMany({
    where:  { type: "PERSONAL" },
    select: {
      id:                true,
      dashboardSections: { select: { key: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  let spacesNeeding    = 0;
  let sectionsPlanned  = 0;
  let sectionsCreated  = 0;

  for (const space of spaces) {
    const existingKeys = new Set(space.dashboardSections.map((s) => s.key));
    const { sectionsToCreate } = planTemplateApplication(personalTemplate, existingKeys);
    if (sectionsToCreate.length === 0) continue;

    spacesNeeding   += 1;
    sectionsPlanned += sectionsToCreate.length;

    if (!APPLY) continue;

    // Additive-only write. createMany inserts new rows exclusively; existing
    // rows are untouched by construction (and @@unique([spaceId, key]) would
    // reject any duplicate the planner somehow missed).
    const result = await db.spaceDashboardSection.createMany({
      data: sectionsToCreate.map((s) => ({
        spaceId: space.id,
        key:     s.key,
        label:   s.label,
        tab:     s.tab,
        enabled: s.enabled,
        order:   s.order,
        ...(s.config == null ? {} : { config: s.config as Prisma.InputJsonValue }),
      })),
    });
    sectionsCreated += result.count;
  }

  console.log(`\nPersonal spaces scanned:   ${spaces.length}`);
  console.log(`Spaces needing sections:   ${spacesNeeding}`);
  console.log(`Sections planned:          ${sectionsPlanned}`);
  if (APPLY) {
    console.log(`Sections created:          ${sectionsCreated}\n`);
  } else {
    console.log(`Sections created:          0 (dry run)\n`);
    if (sectionsPlanned > 0) {
      console.log("Dry run only — re-run with --apply to write these sections.\n");
    } else {
      console.log("Nothing to do. ✓\n");
    }
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
