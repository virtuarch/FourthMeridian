/**
 * lib/deletion-safety.test.ts  (OPS-2 S5)
 *
 * Schema-scan tripwire for the deletion-safety cascade corrections. Standalone
 * tsx script (house pattern):
 *
 *     npx tsx lib/deletion-safety.test.ts
 *
 * Exits 0 on pass / 1 on failure. No DB, no network — reads
 * prisma/schema.prisma as text and asserts the FK postures that the S7
 * deletion pipeline depends on. If someone reverts a flip (or "fixes" the
 * AuditLog anonymization posture), this fails loudly in `npm test` long
 * before a user delete can destroy shared data.
 *
 * Ratified inventory: docs/initiatives/ops2/OPS2_S5_DELETION_INVENTORY.md.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

const schema = readFileSync(
  path.join(process.cwd(), "prisma", "schema.prisma"),
  "utf8",
);

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/** Extract a model's body (between `model X {` and its closing `}`). */
function modelBody(name: string): string {
  const m = schema.match(new RegExp(`model ${name} \\{([\\s\\S]*?)\\n\\}`, "m"));
  if (!m) throw new Error(`model ${name} not found in schema.prisma`);
  return m[1];
}

console.log("deletion-safety schema tripwires (OPS-2 S5)");

// ── 1. SpaceGoal.createdBy — nullable + SetNull (was Cascade) ────────────────
{
  const body = modelBody("SpaceGoal");
  check(
    "SpaceGoal.createdByUserId is nullable",
    /createdByUserId\s+String\?/.test(body),
  );
  check(
    "SpaceGoal.createdBy is onDelete: SetNull",
    /createdBy\s+User\?\s+@relation\("GoalCreator"[\s\S]*?onDelete: SetNull\)/.test(body),
    "a Cascade here hard-deletes other members' goals when the creator is deleted",
  );
}

// ── 2. SpaceAccountLink.addedByUser — nullable + SetNull (was Cascade) ───────
{
  const body = modelBody("SpaceAccountLink");
  check(
    "SpaceAccountLink.addedByUserId is nullable",
    /addedByUserId\s+String\?/.test(body),
  );
  check(
    "SpaceAccountLink.addedByUser is onDelete: SetNull",
    /addedByUser\s+User\?\s+@relation\("SpaceAccountLinkAdder"[\s\S]*?onDelete: SetNull\)/.test(body),
    "a Cascade here hard-deletes links (incl. HOME) other members rely on",
  );
}

// ── 3. AuditLog — retain-and-anonymize posture must never become Cascade ─────
{
  const body = modelBody("AuditLog");
  check(
    "AuditLog.user is onDelete: SetNull (retain & anonymize)",
    /user\s+User\?\s+@relation\(fields: \[userId\][\s\S]*?onDelete: SetNull\)/.test(body),
  );
  check(
    "AuditLog.space is onDelete: SetNull (retain & anonymize)",
    /space\s+Space\?\s+@relation\(fields: \[spaceId\][\s\S]*?onDelete: SetNull\)/.test(body),
  );
}

console.log(
  failures === 0 ? "\nAll deletion-safety checks passed." : `\n${failures} failure(s).`,
);
process.exit(failures === 0 ? 0 : 1);
