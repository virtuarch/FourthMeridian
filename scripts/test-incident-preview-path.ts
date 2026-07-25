/**
 * scripts/test-incident-preview-path.ts  (OPS-2D-5D-1)
 *
 * FULL-PATH runtime proof for the canonical sync-incident Preview.
 *
 * The component test renders fabricated DTOs and the core test scans source.
 * Neither proves the thing that actually matters — that a real incident, written
 * by the real producer facade into a real PostgreSQL database, arrives on an
 * operator's screen with the right depth, label, severity and recovery wording.
 * That chain is what this harness walks end to end:
 *
 *     recordSyncIssue (real facade → real lifecycle authority)
 *       → SyncIssue + SyncIssueOccurrence rows in Postgres
 *       → getActiveIncidentPage  (canonical read authority)
 *       → getIncidentPreview     (ordering + subject resolution)
 *       → IncidentPreview        (the real React component)
 *       → rendered markup, asserted
 *
 * ⚠️ DISPOSABLE DATABASE ONLY. This never sources .env.local — that is the
 * development database and it holds real data. Run it against a throwaway
 * container:
 *
 *   docker run -d --name incident-preview-db -e POSTGRES_PASSWORD=x \
 *     -e POSTGRES_USER=x -e POSTGRES_DB=x -p 127.0.0.1:55433:5432 postgres:16-alpine
 *   URL="postgresql://x:x@127.0.0.1:55433/x"
 *   DATABASE_URL=$URL DIRECT_URL=$URL npx prisma migrate deploy
 *   DATABASE_URL=$URL DIRECT_URL=$URL npx tsx \
 *     --require ./scripts/lib/server-only-preload.cjs scripts/test-incident-preview-path.ts
 *   docker rm -f incident-preview-db
 *
 * It refuses to run against anything that looks like the dev or production
 * database, because the cost of being wrong about that is unrecoverable.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { db } from "@/lib/db";
import { recordSyncIssue } from "@/lib/plaid/syncIssues";
import { getIncidentPreview } from "@/lib/platform/incidents/preview";
import { IncidentPreview } from "@/components/platform/widgets/IncidentPreview";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

// ── Safety gate ──────────────────────────────────────────────────────────────
// A disposable container publishes on a loopback port and is named for this
// slice. Anything else — a pooler host, a Supabase URL, the default 5432 dev
// database — is refused rather than inspected further.
const URL_ = process.env.DATABASE_URL ?? "";
if (!/^postgres(ql)?:\/\/[^@]+@(127\.0\.0\.1|localhost):554\d\d\//.test(URL_)) {
  console.error(
    "REFUSED: DATABASE_URL does not look like a disposable local container on 127.0.0.1:554xx.\n" +
    "         This harness writes incident rows and must never touch the dev or production database.",
  );
  process.exit(1);
}

const SECTION = { id: "s", key: "cs_sync_issues", label: "Sync Incidents" };

function render(data: Awaited<ReturnType<typeof getIncidentPreview>>) {
  const html = renderToStaticMarkup(
    createElement(IncidentPreview, { section: SECTION, data, loading: false, error: null }),
  );
  return { html, text: html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() };
}
const rowCount = (html: string) => (html.match(/<li/g) ?? []).length;

async function main() {
  // ── Fixture: two real referents so neither incident is orphaned ────────────
  const user = await db.user.create({
    data: { email: `ops-preview-${Date.now()}@example.test`, name: "Ops Preview" },
  });
  const item = await db.plaidItem.create({
    data: {
      userId: user.id,
      externalItemId: `item-${Date.now()}`,
      institutionId: "ins_3",
      institutionName: "Chase",
      encryptedToken: "not-a-real-token",
    },
  });
  const account = await db.financialAccount.create({
    data: {
      ownerType: "USER", ownerUserId: user.id,
      name: "Brokerage", type: "investment", institution: "Fidelity", balance: 0,
    },
  });

  // ── Write incidents through the REAL producer facade ───────────────────────
  // Three failures of ONE operation on ONE item. Under the episode model these
  // must converge: one SyncIssue, three SyncIssueOccurrence rows.
  console.log("A. producing incidents through the real facade");
  for (const txn of ["txn-1", "txn-2", "txn-3"]) {
    await recordSyncIssue({
      kind: "TRANSACTION_PERSISTENCE_FAILED",
      provider: "PLAID",
      plaidItemId: item.id,
      plaidTransactionId: txn,
      detail: {
        stage: "transaction-persist",
        cursorBlocking: true,
        merchant: "SECRET_MERCHANT_XYZ",
        amount: 91.44,
      },
    });
  }
  await recordSyncIssue({
    kind: "INVESTMENT_DATA_PERSISTENCE_FAILED",
    provider: "PLAID",
    financialAccountId: account.id,
    detail: { stage: "investment-events", message: "SECRET_INTERNAL_TRACE" },
  });

  const episodes = await db.syncIssue.findMany({ include: { _count: { select: { occurrences: true } } } });
  check("three failures of one operation converged onto ONE episode",
    episodes.filter((e) => e.kind === "TRANSACTION_PERSISTENCE_FAILED").length === 1,
    `${episodes.length} episodes total`);
  const tx = episodes.find((e) => e.kind === "TRANSACTION_PERSISTENCE_FAILED");
  check("…carrying three occurrences", tx?._count.occurrences === 3, `${tx?._count.occurrences}`);
  const inv = episodes.find((e) => e.kind === "INVESTMENT_DATA_PERSISTENCE_FAILED");
  check("the investment episode carries one occurrence", inv?._count.occurrences === 1, `${inv?._count.occurrences}`);

  // ── The canonical read path ───────────────────────────────────────────────
  console.log("B. database → projection → preview DTO");
  const preview = await getIncidentPreview();
  check("two active incidents", preview.activeTotal === 2, `${preview.activeTotal}`);
  check("two preview items", preview.items.length === 2, `${preview.items.length}`);
  check("severity distribution is canonical",
    preview.severityCounts.critical === 1 && preview.severityCounts.error === 1,
    JSON.stringify(preview.severityCounts));
  check("critical is ordered first", preview.items[0].severity === "critical", preview.items[0].severity);
  check("the DTO carries no detail field",
    !JSON.stringify(preview).includes("SECRET_MERCHANT_XYZ") &&
    !JSON.stringify(preview).includes("SECRET_INTERNAL_TRACE"));

  // ── The rendered operator surface ─────────────────────────────────────────
  console.log("C. preview DTO → rendered workspace surface");
  const { html, text } = render(preview);
  check("two incident rows render", rowCount(html) === 2, `${rowCount(html)}`);
  check('the three-occurrence episode reads "Occurred 3 times"', text.includes("Occurred 3 times"));
  check('the one-occurrence episode reads "Occurred once"', text.includes("Occurred once"));
  check("canonical transaction label", text.includes("Transaction persistence failed"));
  check("canonical investment label", text.includes("Investment data persistence failed"));
  check("canonical severities", text.includes("critical") && text.includes("error"));
  check("the held cursor offers automatic recovery", text.includes("Automatic recovery available"));
  check("the investment condition states there is no rule", text.includes("No automatic recovery rule"));
  check("subject resolved from the plaid item", text.includes("Chase"));
  check("subject resolved from the financial account", text.includes("Fidelity") && text.includes("Brokerage"));
  check("no raw detail reaches the markup",
    !html.includes("SECRET_MERCHANT_XYZ") && !html.includes("SECRET_INTERNAL_TRACE") && !html.includes("91.44"));
  check("no raw id reaches the markup", !text.includes(item.id) && !text.includes(account.id));

  // ── Resolved incidents leave the active preview ───────────────────────────
  console.log("D. a resolved episode leaves the active preview");
  await db.syncIssue.update({
    where: { id: tx!.id },
    data: { resolved: true, resolvedAt: new Date(), resolutionKind: "AUTOMATIC_RECOVERY" },
  });
  const after = await getIncidentPreview();
  check("the resolved episode is gone from the active preview", after.activeTotal === 1, `${after.activeTotal}`);
  const afterR = render(after);
  check("…and off the rendered surface", !afterR.text.includes("Transaction persistence failed"), afterR.text);
  check("the remaining condition is still shown", afterR.text.includes("Investment data persistence failed"));
  check("the surface never claims the platform is healthy", !/healthy/i.test(afterR.text));

  // ── An unresolvable subject ───────────────────────────────────────────────
  console.log("E. a deleted referent never renders as a guess");
  // Point an incident at an account, then delete the account. The projection
  // derives `orphaned` (so it leaves the ACTIVE set entirely) — which is itself
  // the honest behaviour, and is asserted rather than assumed.
  const ghost = await db.financialAccount.create({
    data: { ownerType: "USER", ownerUserId: user.id, name: "Ghost", type: "investment", institution: "Nowhere", balance: 0 },
  });
  await recordSyncIssue({
    kind: "IMPORT_ROLLBACK_FAILED", provider: "PLAID",
    financialAccountId: ghost.id, detail: { stage: "import-rollback-repair" },
  });
  const withGhost = await getIncidentPreview();
  check("the ghost incident is active while its account exists", withGhost.activeTotal === 2, `${withGhost.activeTotal}`);
  check("its subject renders as a name, not an id", render(withGhost).text.includes("Nowhere"));

  await db.financialAccount.delete({ where: { id: ghost.id } });
  const orphaned = await getIncidentPreview();
  check("once its referent is gone the incident is no longer ACTIVE (orphaned)",
    orphaned.activeTotal === 1, `${orphaned.activeTotal}`);
  check("no raw id was substituted for the missing subject",
    !render(orphaned).text.includes(ghost.id));

  // ── The empty state, from a real empty database ───────────────────────────
  console.log("F. an empty database renders the honest empty state");
  await db.syncIssueOccurrence.deleteMany({});
  await db.syncIssue.deleteMany({});
  const empty = await getIncidentPreview();
  check("no active incidents", empty.activeTotal === 0 && empty.items.length === 0);
  const emptyR = render(empty);
  check("states there are none", emptyR.text.includes("No active sync incidents"));
  check("does not claim health", !/everything is healthy|all clear/i.test(emptyR.text));
  check("disclaims platform health", /does not describe overall platform health/i.test(emptyR.text));

  if (failures > 0) { console.error(`\nincident-preview-path: ${failures} failure(s).`); process.exit(1); }
  console.log("\nincident-preview-path: all passed.");
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => db.$disconnect());
