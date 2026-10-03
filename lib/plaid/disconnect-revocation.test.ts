/**
 * lib/plaid/disconnect-revocation.test.ts
 *
 * A FAILED PROVIDER REMOVAL MUST NOT BECOME A TERMINAL LOCAL SUCCESS.
 *
 *   npx tsx lib/plaid/disconnect-revocation.test.ts
 *
 * House pattern: standalone tsx, DB-free, no Plaid API. It drives the REAL
 * `disconnectPlaidItemIfOrphaned` through its `{ db, plaid, setHealth }` seam.
 *
 * ══ THE DEFECT, AND WHY IT COST SEVEN LIVE ITEMS ════════════════════════════
 *
 * `itemRemove` failed, the catch logged, and `setPlaidItemHealth(REVOKED)` ran
 * ANYWAY. REVOKED is a one-way door (`health-transitions.ts` drops any
 * non-REVOKED write to a REVOKED row unless `allowReactivation`), and EVERY
 * retry work-list in the repository selects `status: ACTIVE`. So one unconfirmed
 * failure removed the item from all of them at once, while the Item kept
 * existing at Plaid, kept emitting webhooks and — per the vendored SDK, for
 * Transactions/Liabilities/Investments — KEPT BILLING.
 *
 * `056de06` (2026-07-22) named this path by SHA and blamed it for stranding
 * seven live Production Items, then routed a one-off script around it rather
 * than repairing it. `657e850`, four hours earlier the same day, had already
 * built the correct classifier for the DELETION path and never back-ported it.
 *
 * ══ THE TWO TRUTHS THIS KEEPS SEPARATE ═════════════════════════════════════
 *
 * PRODUCT LIFECYCLE — Disconnect is immediately REVOKED from the user's point
 * of view, and a failed `itemRemove` must NOT make the institution reappear.
 * `lib/connections/space-data.ts` loads the Connections surface with
 * `status: { not: REVOKED }`, so "leave it ACTIVE until confirmed" would render
 * a ghost card with zero accounts the instant the user pressed Disconnect —
 * the exact regression `health-transitions.ts` records having fixed once
 * already. So REVOKED stays, unconditionally.
 *
 * PROVIDER CLEANUP LIFECYCLE — separately, and durably: was the removal
 * CONFIRMED upstream, or does cleanup remain owed? That is what the defect had
 * no representation for at all.
 *
 * ⚠️ AND `ITEM_NOT_FOUND` IS A REPO ASSERTION, NOT A VENDORED FACT. Measured:
 * `grep -c ITEM_NOT_FOUND node_modules/plaid/dist/api.d.ts` = 0, and the same
 * for INVALID_ACCESS_TOKEN. The only vendored statement is that the token "is
 * no longer valid" after a successful removal. `revocation.ts` asserts the
 * mapping with written reasoning and deliberately EXCLUDES
 * INVALID_ACCESS_TOKEN ("guessing there would let us claim a revocation we
 * never made"); three operator scripts contradict it. This suite reuses that
 * classifier unchanged and does not widen it — which is why the design fails
 * toward "cleanup still owed" rather than toward a claim we cannot substantiate.
 */

process.env.ENCRYPTION_KEY ??= "0".repeat(64);

import { encryptWithPurpose, EncryptionPurpose } from "./encryption";
import { disconnectPlaidItemIfOrphaned } from "./disconnect";
import { AuditAction } from "@/lib/audit-actions";
import { classifyRevocationFailure, TERMINAL_ALREADY_GONE_CODES } from "@/lib/account-deletion/revocation";

const FAKE_TOKEN = encryptWithPurpose("access-sandbox-test-token", EncryptionPurpose.PLAID_ACCESS_TOKEN);

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

/** A Plaid error exactly as `isAxiosError`/`getPlaidErrorCode` read one. */
const plaidError = (code: string, status = 400) => ({
  isAxiosError: true,
  response: { status, data: { error_code: code, error_type: "ITEM_ERROR" } },
  message: `Plaid ${code}`,
});

type AuditRow = { action: string; metadata: Record<string, unknown>; createdAt: Date };

function makeFakeDb(opts: { liveConnections?: number } = {}) {
  const audits: AuditRow[] = [];
  const item = { id: "item_1", userId: "u1", encryptedToken: FAKE_TOKEN, status: "ACTIVE", institutionName: "Chase" };
  let clock = 0;
  return {
    _audits: audits, _item: item,
    accountConnection: { count: async () => opts.liveConnections ?? 0 },
    plaidItem: {
      findUnique: async () => ({ ...item }),
      update: async ({ data }: { data: { status?: string } }) => {
        if (data.status) item.status = data.status;
        return { ...item };
      },
    },
    auditLog: {
      create: async ({ data }: { data: { action: string; metadata?: Record<string, unknown> } }) => (
        audits.push({ action: data.action, metadata: data.metadata ?? {}, createdAt: new Date(2026, 0, 1, 0, 0, clock++) }),
        { id: `al${audits.length}` }),
      findMany: async () => audits.map((a, n) => ({ id: `al${n + 1}`, ...a })),
    },
  };
}

/** The product-visible health write, observed rather than mocked away. */
function makeSetHealth(fdb: ReturnType<typeof makeFakeDb>) {
  const calls: { status: string }[] = [];
  const fn = (async (_id: string, health: { status: string }) => {
    calls.push({ status: health.status });
    fdb._item.status = health.status;
  }) as never;
  return { fn, calls };
}

/**
 * THE OPERATOR DISCOVERY PREDICATE, as scripts/cleanup-orphaned-plaid-items.ts
 * will ask it. Expressed here so the test asserts the PROPERTY ("cleanup can
 * still find this item") rather than a particular query's syntax.
 *
 * Eligible = the item's most recent revocation marker is UNCONFIRMED. A later
 * CONFIRMED row closes it; that is what makes a successful later cleanup
 * resolve the marker instead of needing a delete.
 */
function cleanupEligible(audits: AuditRow[], plaidItemId: string): boolean {
  const mine = audits
    .filter((a) => a.metadata.plaidItemId === plaidItemId)
    .filter((a) => a.action === AuditAction.PLAID_ITEM_REVOCATION_UNCONFIRMED
                || a.action === AuditAction.PLAID_ITEM_REVOCATION_CONFIRMED)
    .sort((x, y) => x.createdAt.getTime() - y.createdAt.getTime());
  return mine.length > 0 && mine[mine.length - 1].action === AuditAction.PLAID_ITEM_REVOCATION_UNCONFIRMED;
}

async function main(): Promise<void> {
  // ══ 0. THE CLASSIFIER IS REUSED, NOT REPLACED, AND NOT WIDENED ════════════
  console.log("\n0. the existing revocation classifier is the authority here");
  check("ITEM_NOT_FOUND is the ONLY success-equivalent code",
    JSON.stringify(TERMINAL_ALREADY_GONE_CODES) === JSON.stringify(["ITEM_NOT_FOUND"]),
    JSON.stringify(TERMINAL_ALREADY_GONE_CODES));
  check("ITEM_NOT_FOUND classifies already-gone", classifyRevocationFailure("ITEM_NOT_FOUND") === "already-gone");
  check("INVALID_ACCESS_TOKEN is DELIBERATELY retryable, not success",
    classifyRevocationFailure("INVALID_ACCESS_TOKEN") === "retryable");
  check("an unknown code is retryable", classifyRevocationFailure("INTERNAL_SERVER_ERROR") === "retryable");
  check("no code at all (network/decrypt) is retryable", classifyRevocationFailure(undefined) === "retryable");

  // ══ 1. THE PRODUCT TRUTH, WHICH MUST NOT CHANGE ═══════════════════════════
  console.log("\n1. a failed removal still REVOKES product-visibly — the card must not come back");
  {
    const fdb = makeFakeDb();
    const { fn: setHealth, calls } = makeSetHealth(fdb);
    await disconnectPlaidItemIfOrphaned("item_1", {
      db: fdb as never,
      plaid: { itemRemove: async () => { throw plaidError("INTERNAL_SERVER_ERROR", 500); } } as never,
      setHealth,
    });
    check("status is REVOKED even though the provider call failed",
      fdb._item.status === "REVOKED" && calls.some((c) => c.status === "REVOKED"),
      `status=${fdb._item.status} healthCalls=${JSON.stringify(calls)}`);
  }

  // ══ 2. THE DEFECT: CLEANUP IS NOT DURABLY REPRESENTED ═════════════════════
  // THIS IS THE REPRODUCTION. Pre-repair both assertions FAIL, and that is the
  // point: the item is terminally REVOKED, invisible to every `status: ACTIVE`
  // work-list, with nothing anywhere recording that removal was never confirmed.
  console.log("\n2. …and the provider cleanup it still owes is durably recorded");
  {
    const fdb = makeFakeDb();
    const { fn: setHealth } = makeSetHealth(fdb);
    await disconnectPlaidItemIfOrphaned("item_1", {
      db: fdb as never,
      plaid: { itemRemove: async () => { throw plaidError("INTERNAL_SERVER_ERROR", 500); } } as never,
      setHealth,
    });

    const unconfirmed = fdb._audits.filter((a) => a.action === AuditAction.PLAID_ITEM_REVOCATION_UNCONFIRMED);
    check("an UNCONFIRMED marker was written", unconfirmed.length === 1,
      `markers=${JSON.stringify(fdb._audits.map((a) => a.action))}`);
    check("it names the item and carries the provider's code, so an operator can act on it",
      unconfirmed[0]?.metadata.plaidItemId === "item_1"
        && unconfirmed[0]?.metadata.plaidErrorCode === "INTERNAL_SERVER_ERROR",
      JSON.stringify(unconfirmed[0]?.metadata));
    check("the item is DISCOVERABLE by the operator cleanup predicate",
      cleanupEligible(fdb._audits, "item_1"));
    // The defect in one line: a `status: ACTIVE` work-list cannot see it, so the
    // marker is the ONLY thing that keeps it findable.
    check("DENOMINATOR: a status:ACTIVE work-list would NOT find it — the marker is the only handle",
      fdb._item.status === "REVOKED");
  }

  // ══ 3. SUCCESS AND ALREADY-GONE ARE CONFIRMED, NOT MERELY QUIET ═══════════
  console.log("\n3. confirmed outcomes are recorded as confirmed");
  {
    const ok = makeFakeDb();
    await disconnectPlaidItemIfOrphaned("item_1", {
      db: ok as never, plaid: { itemRemove: async () => ({ data: { request_id: "r1" } }) } as never,
      setHealth: makeSetHealth(ok).fn,
    });
    check("a successful itemRemove writes CONFIRMED and no UNCONFIRMED",
      ok._audits.some((a) => a.action === AuditAction.PLAID_ITEM_REVOCATION_CONFIRMED)
        && !ok._audits.some((a) => a.action === AuditAction.PLAID_ITEM_REVOCATION_UNCONFIRMED),
      JSON.stringify(ok._audits.map((a) => a.action)));
    check("…and it is NOT eligible for cleanup", !cleanupEligible(ok._audits, "item_1"));

    const gone = makeFakeDb();
    await disconnectPlaidItemIfOrphaned("item_1", {
      db: gone as never,
      plaid: { itemRemove: async () => { throw plaidError("ITEM_NOT_FOUND"); } } as never,
      setHealth: makeSetHealth(gone).fn,
    });
    check("ITEM_NOT_FOUND is treated as the desired remote state already achieved — CONFIRMED",
      gone._audits.some((a) => a.action === AuditAction.PLAID_ITEM_REVOCATION_CONFIRMED)
        && !cleanupEligible(gone._audits, "item_1"),
      JSON.stringify(gone._audits.map((a) => a.action)));

    // The one the three operator scripts get wrong.
    const invalid = makeFakeDb();
    await disconnectPlaidItemIfOrphaned("item_1", {
      db: invalid as never,
      plaid: { itemRemove: async () => { throw plaidError("INVALID_ACCESS_TOKEN"); } } as never,
      setHealth: makeSetHealth(invalid).fn,
    });
    check("INVALID_ACCESS_TOKEN stays UNCONFIRMED — never silently promoted to success",
      cleanupEligible(invalid._audits, "item_1"),
      JSON.stringify(invalid._audits.map((a) => a.action)));
  }

  // ══ 4. IDEMPOTENCE, AND THE MARKER CLEARING ON LATER SUCCESS ══════════════
  console.log("\n4. repeated cleanup is idempotent, and a later success resolves the marker");
  {
    const fdb = makeFakeDb();
    const { fn: setHealth, calls } = makeSetHealth(fdb);
    const fail = { itemRemove: async () => { throw plaidError("INTERNAL_SERVER_ERROR", 500); } } as never;

    await disconnectPlaidItemIfOrphaned("item_1", { db: fdb as never, plaid: fail, setHealth });
    await disconnectPlaidItemIfOrphaned("item_1", { db: fdb as never, plaid: fail, setHealth });
    check("two failed attempts leave it eligible exactly once-and-still-eligible, not double-counted into success",
      cleanupEligible(fdb._audits, "item_1") && fdb._item.status === "REVOKED");
    check("repeated cleanup does not recreate product-visible state (status never leaves REVOKED)",
      calls.every((c) => c.status === "REVOKED") && fdb._item.status === "REVOKED",
      JSON.stringify(calls));

    // Now the provider call succeeds — the owed cleanup is discharged.
    await disconnectPlaidItemIfOrphaned("item_1", {
      db: fdb as never, plaid: { itemRemove: async () => ({ data: { request_id: "r2" } }) } as never, setHealth,
    });
    check("a later successful cleanup RESOLVES the marker — no longer eligible",
      !cleanupEligible(fdb._audits, "item_1"),
      JSON.stringify(fdb._audits.map((a) => a.action)));
    check("…and the resolution is additive history, not a deletion of the failure record",
      fdb._audits.filter((a) => a.action === AuditAction.PLAID_ITEM_REVOCATION_UNCONFIRMED).length === 2);
  }

  // ══ 5. THE SHORT-CIRCUIT IS UNCHANGED ════════════════════════════════════
  console.log("\n5. an item that still has live connections is untouched");
  {
    const fdb = makeFakeDb({ liveConnections: 1 });
    const { fn: setHealth, calls } = makeSetHealth(fdb);
    let called = false;
    await disconnectPlaidItemIfOrphaned("item_1", {
      db: fdb as never,
      plaid: { itemRemove: async () => { called = true; return { data: {} }; } } as never,
      setHealth,
    });
    check("no provider call, no health write, no marker — the orphan gate still gates",
      !called && calls.length === 0 && fdb._audits.length === 0 && fdb._item.status === "ACTIVE");
  }

  // ══ 6. [source] EVERY REVOCATION PATH GOES THROUGH THIS ONE FUNCTION ══════
  // The repair is inside disconnectPlaidItemIfOrphaned, so its value depends
  // entirely on nothing revoking an orphaned item around it. That is asserted
  // over the whole repository rather than reviewed, and the denominators are
  // named so a zero can never be a zero of nothing.
  console.log("\n6. [source] the repaired function is the only orphan-revocation path");
  {
    const { readFileSync, readdirSync, statSync } = await import("node:fs");
    const path = await import("node:path");
    const ROOT = process.cwd();
    const strip = (t: string) => t.replace(/\/\*[\s\S]*?\*\/|(^|[^:])\/\/.*$/gm, "$1");
    const walk = (d: string, out: string[] = []): string[] => {
      for (const e of readdirSync(path.join(ROOT, d))) {
        if (e === "node_modules" || e.startsWith(".")) continue;
        const rel = path.join(d, e);
        if (statSync(path.join(ROOT, rel)).isDirectory()) walk(rel, out);
        // Tests are excluded: they are not runtime, and this suite's own
        // NEEDLE CONTROL literal would otherwise report itself as a rogue
        // writer of the terminal status. Measured — it did.
        else if (/\.(ts|tsx)$/.test(e) && !/\.test\.tsx?$/.test(e)) out.push(rel);
      }
      return out;
    };
    const files = [...walk("app"), ...walk("lib"), ...walk("jobs"), ...walk("scripts")];
    const src = new Map(files.map((f) => [f, strip(readFileSync(path.join(ROOT, f), "utf8"))]));

    // Everything that calls the repaired function. These are COVERED for free.
    const callers = files.filter((f) => f !== "lib/plaid/disconnect.ts"
      && /disconnectPlaidItemIfOrphaned\s*\(/.test(src.get(f)!));
    check(`DENOMINATOR: the scan saw ${files.length} files and found ${callers.length} callers of the repaired function`,
      files.length > 800 && callers.length >= 5, callers.join(", "));

    // Anything calling itemRemove directly is NOT covered by this repair, so
    // each one must be a KNOWN path with its own semantics rather than a
    // forgotten orphan-revocation route.
    const CLASSIFIED_DIRECT_ITEM_REMOVE: Record<string, string> = {
      "lib/plaid/disconnect.ts":        "the repaired function itself",
      "lib/account-deletion/purge.ts":  "the deletion path — already conditional (657e850); owns its own bounded retry",
      "lib/plaid/exchangeToken.ts":     "duplicate-institution gate: removes an item it just created, before any local row exists",
      "scripts/db-wipe.ts":             "operator, dev-only; carries its own (contradicting) classifier — reported, not fixed in this slice",
      "scripts/remove-plaid-connection.ts": "operator, single institution; revokes at Plaid FIRST and touches the DB only on success",
      "scripts/remove-orphaned-plaid-items-from-backup.ts": "operator recovery from a dump; no live DB",
      "scripts/reset-chase-history-test.ts": "dev fixture",
    };
    const direct = files.filter((f) => /\bplaidClient\.itemRemove\s*\(|\bplaid\.itemRemove\s*\(/.test(src.get(f)!));
    const unclassified = direct.filter((f) => !(f in CLASSIFIED_DIRECT_ITEM_REMOVE));
    check(`every direct itemRemove caller is classified (${direct.length} found, ${unclassified.length} unclassified)`,
      unclassified.length === 0,
      `UNCLASSIFIED: ${unclassified.join(", ")} — if this is a new orphan-revocation path it must route through disconnectPlaidItemIfOrphaned, not re-implement it`);

    // And the one that matters most: who else can put an item into the terminal
    // status, which is what made the old defect invisible to every work-list.
    //
    // ⚠️ THE NEEDLE MATCHES AN ASSIGNMENT, NOT A MENTION. A first version tested
    // for `PlaidItemStatus.REVOKED` anywhere in a file plus an update call
    // anywhere in the same file, and reported four offenders — of which TWO were
    // the platform-ops routes merely GUARDING on `item.status === REVOKED`. A
    // needle that cannot tell a write from a comparison would have been
    // "satisfied" by adding guards to an allowlist, which is how a real writer
    // slips in later. `status:` (the data-literal form) excludes `===`.
    const WRITES_REVOKED = /status:\s*PlaidItemStatus\.REVOKED/;
    const writesRevoked = files.filter((f) => f !== "lib/plaid/disconnect.ts" && WRITES_REVOKED.test(src.get(f)!));
    check("NEEDLE CONTROL: it does not fire on a comparison",
      !WRITES_REVOKED.test("if (item.status === PlaidItemStatus.REVOKED) return;")
        && WRITES_REVOKED.test("data: { status: PlaidItemStatus.REVOKED }"));
    const CLASSIFIED_REVOKERS: Record<string, string> = {
      "lib/connections/health-transitions.ts": "the CH-2 chokepoint — the only legitimate writer of item health",
      "lib/account-deletion/purge.ts":         "the deletion path; already writes only on a CONFIRMED outcome (657e850)",
      "scripts/remove-plaid-connection.ts":    "operator; revokes at Plaid FIRST and writes only on success (056de06's workaround)",
      "scripts/reset-chase-history-test.ts":   "dev fixture",
    };
    const rogue = writesRevoked.filter((f) => !(f in CLASSIFIED_REVOKERS));
    check(`every file that can write REVOKED is classified (${writesRevoked.length} found, ${rogue.length} unclassified)`,
      rogue.length === 0,
      `UNCLASSIFIED: ${rogue.join(", ")} — a new terminal-status writer must record whether the provider removal was confirmed, or it reintroduces the defect`);
  }

  console.log(
    failures === 0
      ? "\n✅ a failed provider removal is product-terminal but cleanup-recoverable, and confirmation is never assumed.\n"
      : `\n❌ ${failures} failure(s)\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
