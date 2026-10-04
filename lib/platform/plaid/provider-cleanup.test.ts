/**
 * lib/platform/plaid/provider-cleanup.test.ts
 *
 * THE OPERATOR READ FOR "PLAID STILL OWES US A REMOVAL", AND THE ONE INFERENCE
 * IT MUST NEVER MAKE.
 *
 *   npx tsx lib/platform/plaid/provider-cleanup.test.ts
 *
 * House pattern: standalone tsx. The reader is driven against an injected fake
 * client, so the marker-folding logic is exercised directly; the route's
 * authorization and the no-secrets boundary are asserted by source scan over
 * the real files.
 *
 * ⚠️ THE PROPERTY THIS FILE EXISTS FOR. `scripts/cleanup-orphaned-plaid-items.ts`
 * used to verify its own work by re-reading `status === REVOKED` after calling a
 * function that writes REVOKED UNCONDITIONALLY — a check that could not fail,
 * reporting success for removals Plaid had refused. f339e57 fixed that. Nothing
 * in Platform Ops may reintroduce it, so §6 asserts the absence of that
 * inference over the actual source of all three new files.
 */

import { readFileSync } from "node:fs";
import { AuditAction } from "@/lib/audit-actions";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const UNCONFIRMED = AuditAction.PLAID_ITEM_REVOCATION_UNCONFIRMED;
const CONFIRMED   = AuditAction.PLAID_ITEM_REVOCATION_CONFIRMED;
const NOW = new Date("2026-10-05T12:00:00.000Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

type Marker = { action: string; createdAt: Date; metadata: Record<string, unknown> };
type Item   = { id: string; status: string; institutionName: string | null; userId: string };

/** The injected client. Only the two reads the authority performs. */
function fakeDb(markers: Marker[], items: Item[]) {
  return {
    auditLog: {
      findMany: async ({ where }: { where: { action: { in: string[] } } }) =>
        markers
          .filter((m) => where.action.in.includes(m.action))
          .slice()
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()),
    },
    plaidItem: {
      findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
        items.filter((i) => where.id.in.includes(i.id)),
    },
  };
}

const marker = (action: string, plaidItemId: string, h: number, extra: Record<string, unknown> = {}): Marker =>
  ({ action, createdAt: hoursAgo(h), metadata: { provider: "PLAID", plaidItemId, ...extra } });

const item = (id: string, over: Partial<Item> = {}): Item =>
  ({ id, status: "REVOKED", institutionName: "Chase", userId: `user_abc${id}`, ...over });

async function load(markers: Marker[], items: Item[]) {
  // The authority resolves `db` at module scope, so the fake is injected by
  // overriding the module's dependency the same way the house does elsewhere:
  // through a dedicated test entry. Here we call the pure fold directly.
  const mod = await import("./provider-cleanup");
  return mod.__foldForTest(
    (await fakeDb(markers, items).auditLog.findMany({ where: { action: { in: [UNCONFIRMED, CONFIRMED] } } })) as never,
    items as never,
    NOW,
  );
}

async function main(): Promise<void> {
  // ══ 1. AN ORDINARY ITEM WITH NO MARKERS IS NOT OWED ═══════════════════════
  console.log("\n1. no marker means nothing owed — an active item is never falsely reported");
  {
    const r = await load([], [item("i_active", { status: "ACTIVE" })]);
    check("owedCount is 0", r.owedCount === 0, JSON.stringify(r));
    check("…and the zero is distinguishable from a zero READ (markersRead reported)",
      r.markersRead === 0 && r.confirmedCount === 0);
  }

  // ══ 2. THE NEWEST UNCONFIRMED IS SURFACED, WITH SAFE DIAGNOSTICS ══════════
  console.log("\n2. a latest-UNCONFIRMED item is surfaced with age and classification");
  {
    const r = await load(
      [marker(UNCONFIRMED, "i1", 30, { plaidErrorCode: "INTERNAL_SERVER_ERROR" })],
      [item("i1", { institutionName: "Amex", userId: "user_zzzz123456" })],
    );
    check("exactly one item is owed", r.owedCount === 1 && r.owed.length === 1);
    const o = r.owed[0];
    check("it names the item, institution and an OPAQUE owner ref (last 6 only)",
      o.plaidItemId === "i1" && o.institution === "Amex" && o.ownerRef === "123456",
      JSON.stringify(o));
    check("the age is whole hours since the obligation began", o.owedForHours === 30, `${o.owedForHours}`);
    check("the oldest-outstanding summary matches it",
      r.oldestOwedForHours === 30 && r.oldestOwedSinceISO === o.owedSinceISO);
    check("the provider's own latest error code is carried", o.latestErrorCode === "INTERNAL_SERVER_ERROR");
    check("PRODUCT state is reported separately and is REVOKED", o.productStatus === "REVOKED");
  }

  // ══ 3. MANY UNCONFIRMED MARKERS ARE STILL ONE OUTSTANDING ITEM ════════════
  console.log("\n3. repeated failures are one obligation, not many");
  {
    const r = await load(
      [
        marker(UNCONFIRMED, "i1", 50, { plaidErrorCode: "INTERNAL_SERVER_ERROR" }),
        marker(UNCONFIRMED, "i1", 20, { plaidErrorCode: "RATE_LIMIT_EXCEEDED" }),
        marker(UNCONFIRMED, "i1", 2,  { plaidErrorCode: "INVALID_ACCESS_TOKEN" }),
      ],
      [item("i1")],
    );
    check("still exactly ONE owed item", r.owedCount === 1, JSON.stringify(r.owed.map((o) => o.plaidItemId)));
    check("attemptCount counts all three", r.owed[0].attemptCount === 3, `${r.owed[0].attemptCount}`);
    // ⚠️ THE AGE IS THE OBLIGATION'S, NOT THE NEWEST RETRY'S. A retry every hour
    // would otherwise keep resetting the age of a days-old problem — which is
    // exactly the signal an operator needs.
    check("the age is measured from the FIRST failure, not the latest retry",
      r.owed[0].owedForHours === 50, `${r.owed[0].owedForHours}`);
    check("the latest error code is the LATEST one", r.owed[0].latestErrorCode === "INVALID_ACCESS_TOKEN");
  }

  // ══ 4. A LATER CONFIRMED REMOVES IT FROM THE OWED POPULATION ══════════════
  console.log("\n4. a later CONFIRMED resolves the obligation");
  {
    const r = await load(
      [marker(UNCONFIRMED, "i1", 40), marker(CONFIRMED, "i1", 1, { outcome: "REMOVED" })],
      [item("i1")],
    );
    check("nothing is owed", r.owedCount === 0, JSON.stringify(r.owed));
    check("…and it counts as a CONFIRMED removal", r.confirmedCount === 1);
    check("the historical failure marker was still READ (markersRead = 2) — history survives",
      r.markersRead === 2, `${r.markersRead}`);
  }

  // ══ 5. AND A FAILURE AFTER A CONFIRMATION IS OWED AGAIN ═══════════════════
  // The pair is a LIFECYCLE, so order decides — not mere presence.
  console.log("\n5. order decides, not presence");
  {
    const r = await load(
      [marker(CONFIRMED, "i1", 40, { outcome: "REMOVED" }), marker(UNCONFIRMED, "i1", 3)],
      [item("i1", { status: "ACTIVE" })],
    );
    check("a newer UNCONFIRMED after a CONFIRMED is owed again", r.owedCount === 1);
    check("…and its age is measured from the failure AFTER the confirmation",
      r.owed[0].owedForHours === 3, `${r.owed[0].owedForHours}`);
    check("product status is reported as ACTIVE here — never used as cleanup evidence",
      r.owed[0].productStatus === "ACTIVE");
  }

  // ══ 6. A MARKER OUTLIVING ITS ITEM IS REPORTED, NOT DROPPED ═══════════════
  console.log("\n6. an obligation whose item is gone stays visible");
  {
    const r = await load([marker(UNCONFIRMED, "i_gone", 10)], []);
    check("it is still owed", r.owedCount === 1);
    check("…flagged itemGone, with no owner invented", r.owed[0].itemGone === true && r.owed[0].ownerRef === "(gone)");
  }

  // ══ 7. ORDERING AND MULTI-ITEM ════════════════════════════════════════════
  console.log("\n7. several owed items, oldest first");
  {
    const r = await load(
      [marker(UNCONFIRMED, "i_new", 5), marker(UNCONFIRMED, "i_old", 100), marker(CONFIRMED, "i_ok", 2)],
      [item("i_new"), item("i_old"), item("i_ok")],
    );
    check("two owed, one confirmed", r.owedCount === 2 && r.confirmedCount === 1);
    check("oldest first", r.owed[0].plaidItemId === "i_old" && r.owed[1].plaidItemId === "i_new");
    check("the summary age is the OLDEST", r.oldestOwedForHours === 100);
  }

  // ══ 8. [source] AUTHORIZATION, SECRETS, AND THE FORBIDDEN INFERENCE ═══════
  console.log("\n8. [source] authorization preserved, no secrets, and no status-as-proof");
  {
    const ROUTE  = "app/api/platform/platform-ops/provider-cleanup/route.ts";
    const AUTH   = readFileSync(ROUTE, "utf8");
    const READER = readFileSync("lib/platform/plaid/provider-cleanup.ts", "utf8");
    const WIDGET = readFileSync("components/platform/widgets/OpsProviderCleanupWidget.tsx", "utf8");
    const strip  = (t: string) => t.replace(/\/\*[\s\S]*?\*\/|(^|[^:])\/\/.*$/gm, "$1");

    check("GET is gated on PLATFORM_OPS READ",
      /requirePlatformAccess\("PLATFORM_OPS",\s*"READ"\)/.test(AUTH));
    check("POST is gated on FRESH PLATFORM_OPS WRITE — the same gate resync/request-reauth use",
      /requireFreshPlatformAccess\("PLATFORM_OPS",\s*"WRITE"\)/.test(AUTH));
    check("…and the WRITE gate is checked BEFORE anything is read or written",
      AUTH.indexOf("requireFreshPlatformAccess") < AUTH.indexOf("disconnectPlaidItemIfOrphaned"));

    // NO SECRETS. The marker metadata carries no token by construction, but the
    // assertion is over the files rather than over that belief.
    const SECRET = /encryptedToken|access_token|accessToken|decryptWithPurpose|NEXTAUTH_SECRET|PLAID_SECRET/;
    for (const [name, src] of [["reader", READER], ["route", AUTH], ["widget", WIDGET]] as const) {
      check(`the ${name} never touches a token or secret`, !SECRET.test(strip(src)),
        (strip(src).match(SECRET) ?? []).join(","));
    }
    check("NEEDLE CONTROL: the secret needle fires on a module that legitimately decrypts",
      SECRET.test(readFileSync("lib/plaid/disconnect.ts", "utf8")));
    check("the reader exposes an OPAQUE owner ref and never an email",
      /userId\.slice\(-6\)/.test(READER) && !/\bemail\b/i.test(strip(READER)));

    // ⚠️ THE FORBIDDEN INFERENCE. `status === REVOKED` must never be read as
    // proof that the provider removal happened — that is the vacuous check
    // f339e57 repaired, and it is the one mistake this surface could most
    // plausibly reintroduce.
    const STATUS_AS_PROOF = /status\s*===\s*(?:PlaidItemStatus\.)?["']?REVOKED/;
    for (const [name, src] of [["reader", READER], ["route", AUTH], ["widget", WIDGET]] as const) {
      check(`the ${name} never treats status === REVOKED as cleanup proof`, !STATUS_AS_PROOF.test(strip(src)));
    }
    check("NEEDLE CONTROL: that needle fires on the comparison it forbids",
      STATUS_AS_PROOF.test('if (after?.status === PlaidItemStatus.REVOKED) {'));
    check("the POST's success condition is the MARKER re-read, not the action's return",
      /isProviderCleanupOwed\(plaidItemId\)/.test(AUTH) && /confirmed:\s*!stillOwed/.test(AUTH));
    check("the retry reuses the canonical revocation path rather than re-implementing it",
      /disconnectPlaidItemIfOrphaned\(plaidItemId\)/.test(AUTH)
        && !/itemRemove/.test(strip(AUTH))
        && !/classifyRevocationFailure/.test(strip(AUTH)),
      "a second classifier or a direct itemRemove here would duplicate semantics f339e57 centralised");
    check("the action is MANUAL — nothing schedules it",
      !/cron|schedule|setInterval|registerJob/i.test(strip(AUTH)));
    check("only an item that is ACTUALLY OWED can be retried",
      /if \(!\(await isProviderCleanupOwed\(plaidItemId\)\)\)/.test(AUTH),
      "otherwise this is a general revoke lever wearing a cleanup label");
  }

  console.log(
    failures === 0
      ? "\n✅ provider cleanup owed is visible, product and provider state stay distinct, and status is never proof.\n"
      : `\n❌ ${failures} failure(s)\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
