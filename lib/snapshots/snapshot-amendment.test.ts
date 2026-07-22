/**
 * lib/snapshots/snapshot-amendment.test.ts
 *
 * Phase-2 amendment POLICY guards — the checks that fire BEFORE any
 * regeneration, so they unit-test with a tiny fake client (no DB, no A8/price
 * network calls):
 *
 *     npx tsx lib/snapshots/snapshot-amendment.test.ts
 *
 * The full compute/write behaviour (row tagging, breakdown, AuditLog, frozen +
 * membership guard bypass) is exercised end-to-end against a disposable Space in
 * the integration verification, not here — this file only pins the personal-space
 * and account-scope gates, which must reject before touching any snapshot.
 */

import { previewAmendment, applyAmendment, SharedSpaceAmendmentError, type AmendmentRequest } from "./snapshot-amendment";

type FakeClient = AmendmentRequest["client"];

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

async function expectThrow(fn: () => Promise<unknown>, pred: (e: unknown) => boolean): Promise<boolean> {
  try { await fn(); return false; } catch (e) { return pred(e); }
}

/** Minimal fake satisfying only the guard-path reads. `regenerateWealthHistory`
 *  is never reached in these cases, so no other methods are needed. */
function fakeClient(opts: { spaceType?: "PERSONAL" | "SHARED" | null; hasLink: boolean }): FakeClient {
  return {
    space: { findUnique: async () => (opts.spaceType === null ? null : { type: opts.spaceType }) },
    spaceAccountLink: { findFirst: async () => (opts.hasLink ? { id: "link1" } : null) },
  } as unknown as FakeClient;
}

const req = (client: FakeClient) => ({
  spaceId: "s1", financialAccountId: "a1", kind: "ACCOUNT_ADDED_RETROACTIVE" as const,
  fromDate: "2026-06-01", toDate: "2026-06-07", requestedByUserId: "u1", client,
});

async function main(): Promise<void> {
  console.log("1. Personal-space-only gate (SHARED rejected — that's Phase 3)");
  {
    check("previewAmendment on a SHARED space → SharedSpaceAmendmentError",
      await expectThrow(() => previewAmendment(req(fakeClient({ spaceType: "SHARED", hasLink: true }))), (e) => e instanceof SharedSpaceAmendmentError));
    check("applyAmendment on a SHARED space → SharedSpaceAmendmentError",
      await expectThrow(() => applyAmendment(req(fakeClient({ spaceType: "SHARED", hasLink: true }))), (e) => e instanceof SharedSpaceAmendmentError));
  }

  console.log("2. Space-existence gate");
  {
    check("previewAmendment on a missing space → throws",
      await expectThrow(() => previewAmendment(req(fakeClient({ spaceType: null, hasLink: true }))), (e) => e instanceof Error && /not found/i.test((e as Error).message)));
  }

  console.log("3. Account-scope gate (account must be/have been linked)");
  {
    check("previewAmendment when the account has no link → throws",
      await expectThrow(() => previewAmendment(req(fakeClient({ spaceType: "PERSONAL", hasLink: false }))), (e) => e instanceof Error && /SpaceAccountLink/i.test((e as Error).message)));
    check("applyAmendment when the account has no link → throws",
      await expectThrow(() => applyAmendment(req(fakeClient({ spaceType: "PERSONAL", hasLink: false }))), (e) => e instanceof Error && /SpaceAccountLink/i.test((e as Error).message)));
  }

  // 4. Rebuild RECOMPUTES from canonical inputs — it must NOT copy previously
  //    materialized SpaceSnapshot values (else a bad historical anchor would be
  //    re-frozen verbatim). Source guard: both entry points drive the reconstruction
  //    through regenerateWealthHistory (walk-backs + A8 + classifyAccounts), and the
  //    stored SnapshotAmendmentDay rows are an AUDIT breakdown, not the compute source.
  console.log("4. Amendment recomputes (does not copy materialized reconstruction)");
  {
    const { readFileSync } = await import("fs");
    const { join } = await import("path");
    const src = readFileSync(join(process.cwd(), "lib/snapshots/snapshot-amendment.ts"), "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");
    check("previewAmendment + applyAmendment both recompute via regenerateWealthHistory",
      (code.match(/regenerateWealthHistory\s*\(/g) ?? []).length >= 2);
    check("no SpaceSnapshot READ-BACK feeds the amendment compute (findMany/findUnique on spaceSnapshot)",
      !/spaceSnapshot\.(findMany|findUnique|findFirst)/.test(code));
    check("the derived reconstruction is written by regen's upsert, not copied here",
      !/spaceSnapshot\.(create|createMany|update)\b/.test(code));
  }

  if (failures > 0) { console.error(`\n${failures} check(s) FAILED`); process.exit(1); }
  console.log("\nAll snapshot-amendment policy-guard checks passed.");
  process.exit(0);
}

main();
