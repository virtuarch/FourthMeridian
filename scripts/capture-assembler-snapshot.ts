/**
 * scripts/capture-assembler-snapshot.ts
 *
 * FlowType P5 Slice 4 — before/after evidence capture. READ-ONLY: performs no
 * database writes. Invokes the real TRANSACTIONS_SUMMARY assembler (through
 * the assembler registry, exactly as the context builder does) for one Space
 * and writes the full section JSON to
 * docs/initiatives/flowtype/fixtures/slice4-<label>.json.
 *
 * The before/after diff of these two files is the Slice 4 sign-off evidence
 * (P5_SLICE4_ASSEMBLER_CUTOVER_SIGNOFF.md §5): capture `--label=before` on the
 * pre-cutover assembler, implement, capture `--label=after`, then diff.
 * Run both captures on the same day (the default window is anchored to today)
 * and without syncing in between, so the row population is identical.
 *
 * Run:
 *   npx tsx scripts/capture-assembler-snapshot.ts --label=before [--space=<id>] [--days=90]
 *
 * Space selection: --space=<id> wins; otherwise the oldest PERSONAL Space.
 * The SpaceContext is constructed directly (OWNER of that Space) — this
 * script bypasses NextAuth deliberately; it is a local evidence tool, never
 * deployed.
 */

import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";

// Side-effect import of the ONE assembler under test — deliberately NOT the
// lib/ai/assemblers barrel, whose accounts.ts → lib/account-privacy.ts chain
// pulls in 'server-only' and cannot load under tsx outside Next.js.
import "@/lib/ai/assemblers/transactions";
import { getAssembler } from "@/lib/ai/assembler-registry";
import { FinanceDomains } from "@/lib/ai/types";
import { db } from "@/lib/db";
import type { SpaceContext } from "@/lib/space";

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit?.split("=")[1];
}

async function main(): Promise<void> {
  const label = arg("label");
  if (label !== "before" && label !== "after") {
    console.error("Usage: npx tsx scripts/capture-assembler-snapshot.ts --label=before|after [--space=<id>] [--days=90]");
    process.exit(1);
  }
  const days = Number(arg("days") ?? "90");

  // ── Resolve Space + an OWNER member ────────────────────────────────────────
  const spaceId = arg("space");
  const space = spaceId
    ? await db.space.findUnique({ where: { id: spaceId } })
    : await db.space.findFirst({
        where: { type: "PERSONAL", deletedAt: null },
        orderBy: { createdAt: "asc" },
      });
  if (!space) {
    console.error("capture-assembler-snapshot: no Space found.");
    process.exit(1);
  }
  const owner = await db.spaceMember.findFirst({
    where: { spaceId: space.id, role: "OWNER", status: "ACTIVE" },
  });
  if (!owner) {
    console.error(`capture-assembler-snapshot: Space ${space.id} has no ACTIVE OWNER member.`);
    process.exit(1);
  }

  const spaceCtx: SpaceContext = {
    userId:  owner.userId,
    spaceId: space.id,
    role:    "OWNER",
    permissions: { canInvite: true, canManage: true, canWrite: true, canRead: true, isOwner: true },
    space: {
      id:       space.id,
      name:     space.name,
      type:     space.type,
      category: space.category,
      isPublic: space.isPublic,
      // MC1 Phase 3 Slice 6 — SpaceContext gained the authoritative
      // reporting currency; the snapshot harness mirrors the real resolver.
      reportingCurrency: space.reportingCurrency,
    },
  };

  // ── Fixed explicit window (identical bounds for before + after runs) ──────
  const endIso   = new Date().toISOString().split("T")[0];
  const startIso = new Date(Date.now() - (days - 1) * 86_400_000).toISOString().split("T")[0];

  const assemble = getAssembler(FinanceDomains.TRANSACTIONS_SUMMARY);
  if (!assemble) {
    console.error("capture-assembler-snapshot: TRANSACTIONS_SUMMARY assembler not registered.");
    process.exit(1);
  }

  const section = await assemble(spaceCtx, {
    scopeHint: "full",
    transactionWindow: { startDate: startIso, endDate: endIso, label: `slice4 evidence ${days}d` },
  });

  const out = {
    meta: {
      label,
      capturedAt: new Date().toISOString(),
      spaceId:    space.id,
      window:     { startIso, endIso, days },
    },
    section, // null ⇒ no transactions in window
  };

  const dir  = join(process.cwd(), "docs/initiatives/flowtype/fixtures");
  const file = join(dir, `slice4-${label}.json`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
  console.log(`capture-assembler-snapshot: wrote ${file}`);
  console.log(`  space=${space.id} window=${startIso}..${endIso} (${days}d) section=${section ? "present" : "null"}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => { console.error(err); process.exit(1); });
