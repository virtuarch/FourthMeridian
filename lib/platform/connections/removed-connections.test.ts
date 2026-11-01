/**
 * lib/platform/connections/removed-connections.test.ts  (PB-5)
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/platform/connections/removed-connections.test.ts
 *
 * The Removed connections list, as a pure fold over fixtures (no DB):
 *   1. which connections are "removed" (Plaid REVOKED / marker; wallet hub rule)
 *   2. the DTO: source, account count, opaque owner, removed at
 *   3. removed BY — operator / customer (recorded, inferred) / provider / system / unknown
 *   4. the Plaid outcome, and that the list and the Provider cleanup widget
 *      COUNT THE SAME VERDICTS (one fixture through both folds)
 *   5. filters, paging, query parsing
 *   6. Retry reuses the existing provider-cleanup POST (source pins), and the
 *      reader / route / UI keep the privacy boundary
 */

import { readFileSync } from "node:fs";
import { AuditAction } from "@/lib/audit-actions";
import {
  foldRemovedConnections, queryRemovedConnections, parseRemovedConnectionsQuery, deriveRemovedBy,
  REMOVAL_MATCH_WINDOW_MS, type RemovedConnectionsInputs, type RemovedConnectionRow, type AuditFact,
} from "./removed-connections.core";
import { __foldForTest as foldCleanupStatus } from "@/lib/platform/plaid/provider-cleanup";
import { ownerTokenOf, removedByLabel, removedConnectionsUrl, removeConfirmMessage, EMPTY_FILTERS, PROVIDER_CLEANUP_RETRY_ROUTE, canConfirmRemoval, removeConsequenceLine } from "@/components/platform/widgets/removed-connections-view";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`); }
}
const code = (rel: string) => readFileSync(rel, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

const NOW = new Date("2026-11-02T12:00:00.000Z");
const at = (h: number) => new Date(NOW.getTime() - h * 3_600_000);
const marker = (confirmed: boolean, plaidItemId: string, h: number, extra: Record<string, unknown> = {}) => ({
  action: confirmed ? AuditAction.PLAID_ITEM_REVOCATION_CONFIRMED : AuditAction.PLAID_ITEM_REVOCATION_UNCONFIRMED,
  createdAt: at(h), metadata: { provider: "PLAID", plaidItemId, ...extra },
});
const link = (fa: string, deletedH: number | null, accountDeletedH: number | null = deletedH) =>
  ({ financialAccountId: fa, deletedAt: deletedH === null ? null : at(deletedH), accountDeletedAt: accountDeletedH === null ? null : at(accountDeletedH) });

const OWNER_A = "user_owner_aaaaaa";
const OWNER_B = "user_owner_bbbbbb";
const OPERATOR = "user_operator_zz9";

function fixture(): RemovedConnectionsInputs {
  return {
    plaidItems: [
      // p-op: removed by an operator, Plaid confirmed REMOVED.
      { id: "p-op", userId: OWNER_A, institutionName: "Chase", status: "REVOKED", links: [link("fa1", 5), link("fa2", 5)] },
      // p-cust: customer disconnect that NAMES the connection; Plaid owes cleanup (2 attempts).
      { id: "p-cust", userId: OWNER_A, institutionName: "Amex", status: "REVOKED", links: [link("fa3", 30)] },
      // p-legacy: customer disconnect pre-connectionId (institution only), ALREADY_GONE.
      { id: "p-legacy", userId: OWNER_B, institutionName: "Schwab", status: "REVOKED", links: [link("fa4", 50)] },
      // p-webhook: REVOKED by the provider with its accounts still live; no marker.
      { id: "p-webhook", userId: OWNER_B, institutionName: "Citi", status: "REVOKED", links: [link("fa5", null)] },
      // p-system: an orphan revoked by a job: marker, no customer act.
      { id: "p-system", userId: OWNER_B, institutionName: "Wells", status: "REVOKED", links: [link("fa6", 200)] },
      // p-relinked: removed (CONFIRMED) and since re-linked (ACTIVE again).
      { id: "p-relinked", userId: OWNER_A, institutionName: "Ally", status: "ACTIVE", links: [link("fa7", null)] },
      // p-live: a live item — never in the list.
      { id: "p-live", userId: OWNER_A, institutionName: "Live Bank", status: "ACTIVE", links: [link("fa8", null)] },
    ],
    wallets: [
      { id: "w-removed", userId: OWNER_A, externalConnectionId: "bc1qexampleaddr123456", status: "ACTIVE", links: [link("fa9", 3)] },
      { id: "w-live", userId: OWNER_A, externalConnectionId: null, status: "ACTIVE", links: [link("fa10", null)] },
      { id: "w-discovering", userId: OWNER_B, externalConnectionId: null, status: "ACTIVE", links: [] },
      { id: "w-revoked", userId: OWNER_B, externalConnectionId: null, status: "REVOKED", links: [] },
    ],
    markers: [
      marker(false, "p-cust", 30, { plaidErrorCode: "INTERNAL_SERVER_ERROR" }),
      marker(false, "p-cust", 6, { plaidErrorCode: "RATE_LIMIT" }),
      marker(true, "p-legacy", 50, { outcome: "ALREADY_GONE" }),
      marker(true, "p-system", 200, { outcome: "REMOVED" }),
      marker(true, "p-relinked", 90, { outcome: "REMOVED" }),
      marker(true, "p-op", 5, { outcome: "REMOVED" }),
      // An item deleted after it was owed — the marker outlives it.
      marker(false, "p-gone", 400),
    ].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()),
    revokedTransitions: [
      { action: AuditAction.PLAID_ITEM_STATUS_CHANGED, userId: OWNER_A, createdAt: at(5), metadata: { plaidItemId: "p-op", from: "ACTIVE", to: "REVOKED" } },
      { action: AuditAction.PLAID_ITEM_STATUS_CHANGED, userId: OWNER_B, createdAt: at(10), metadata: { plaidItemId: "p-webhook", from: "ACTIVE", to: "REVOKED" } },
      // A non-REVOKED transition is not a removal time.
      { action: AuditAction.PLAID_ITEM_STATUS_CHANGED, userId: OWNER_A, createdAt: at(1), metadata: { plaidItemId: "p-cust", from: "REVOKED", to: "ERROR" } },
    ],
    customerActs: [
      { action: AuditAction.CONNECTION_DISCONNECTED, userId: OWNER_A, createdAt: at(30), metadata: { institution: "Amex", provider: "PLAID", accountCount: 1, connectionId: "p-cust" } },
      { action: AuditAction.CONNECTION_DISCONNECTED, userId: OWNER_B, createdAt: new Date(at(50).getTime() + 60_000), metadata: { institution: "Schwab", provider: "PLAID", accountCount: 1 } },
      { action: AuditAction.CONNECTION_DISCONNECTED, userId: OWNER_A, createdAt: new Date(at(3).getTime() - 30_000), metadata: { institution: "Self-custody wallet", provider: "WALLET", accountCount: 1 } },
    ],
    operatorActs: [
      { action: AuditAction.CONNECTION_REMOVED_BY_OPERATOR, userId: null, createdAt: at(5), performedByAdminId: OPERATOR,
        metadata: { result: "SUCCESS", target: { kind: "PLAID_ITEM", id: "p-op" }, connectionId: "p-op", removalReason: "abuse" } },
      // A FAILED operator attempt is not the removal.
      { action: AuditAction.CONNECTION_REMOVED_BY_OPERATOR, userId: null, createdAt: at(201), performedByAdminId: OPERATOR,
        metadata: { result: "FAILURE", target: { kind: "PLAID_ITEM", id: "p-system" }, connectionId: "p-system", removalReason: "cost" } },
    ],
    operatorLabel: (id) => (id === OPERATOR ? "opsadmin" : null),
  };
}

const byId = (rows: RemovedConnectionRow[], id: string) => rows.find((r) => r.id === id);

console.log("1. which connections are removed");
const input = fixture();
const rows = foldRemovedConnections(input);
{
  const ids = rows.map((r) => r.id).sort().join();
  check("REVOKED Plaid items, marker-only items (re-linked, deleted) and removed wallets are listed; live ones are not",
    ids === ["p-op", "p-cust", "p-legacy", "p-webhook", "p-system", "p-relinked", "p-gone", "w-removed", "w-revoked"].sort().join(), ids);
  check("a wallet that never had a link (mid-discovery) is NOT removed", !byId(rows, "w-discovering"));
  check("a wallet whose every link is gone IS removed (the hub's own rule)", byId(rows, "w-removed")?.provider === "WALLET");
  check("a re-linked item is flagged, not hidden", byId(rows, "p-relinked")?.relinked === true);
  check("a deleted item's marker keeps a row (itemGone, no owner, not retryable)",
    byId(rows, "p-gone")?.itemGone === true && byId(rows, "p-gone")?.ownerRef === "—" && byId(rows, "p-gone")?.retryEligible === false);
}

console.log("2. the DTO");
{
  const op = byId(rows, "p-op")!;
  check("source = institution label; account count = distinct accounts", op.source === "Chase" && op.accountCount === 2);
  check("owner = the OPAQUE reference connection diagnostics shows (never an id or email)", op.ownerRef === "user …aaaaaa");
  check("removed at = the → REVOKED transition", op.removedAtISO === at(5).toISOString());
  check("removed at falls back to the FIRST marker (not the newest retry)", byId(rows, "p-cust")!.removedAtISO === at(30).toISOString());
  check("a wallet's removed at = its latest link soft-delete", byId(rows, "w-removed")!.removedAtISO === at(3).toISOString());
  check("nothing recorded ⇒ removed at is null, never guessed", byId(rows, "w-revoked")!.removedAtISO === null);
  check("a wallet's label never carries the address", byId(rows, "w-removed")!.source === "Self-custody wallet …123456");
  check("newest removal first; unknown dates last", rows[0].id === "w-removed" && rows[rows.length - 1].removedAtISO === null);
  const json = JSON.stringify(rows);
  check("no email / user id / address in the DTO", !/@|user_owner_|user_operator_|bc1qexample/.test(json), json.match(/@|user_owner_|user_operator_|bc1qexample/)?.[0]);
}

console.log("3. removed BY");
{
  const by = (id: string) => byId(rows, id)!.removedBy;
  check("operator removal → OPERATOR with the operator's display name and reason",
    JSON.stringify(by("p-op")) === JSON.stringify({ kind: "OPERATOR", operator: "opsadmin", reason: "abuse" }), by("p-op"));
  check("UI: \"Removed by operator <name>\"", removedByLabel(by("p-op")) === "Removed by operator opsadmin");
  check("a CONNECTION_DISCONNECTED naming the connection → CUSTOMER (RECORDED)", JSON.stringify(by("p-cust")) === JSON.stringify({ kind: "CUSTOMER", attribution: "RECORDED" }));
  check("a legacy disconnect by the owner, same institution, inside the window → CUSTOMER (INFERRED)",
    JSON.stringify(by("p-legacy")) === JSON.stringify({ kind: "CUSTOMER", attribution: "INFERRED" }), by("p-legacy"));
  check("a wallet disconnect by the owner inside the window → CUSTOMER (INFERRED)", by("w-removed").kind === "CUSTOMER");
  check("REVOKED with live accounts → PROVIDER (the webhook revocation)", by("p-webhook").kind === "PROVIDER");
  check("a marker with no customer act → SYSTEM (and a FAILED operator attempt does not count)", by("p-system").kind === "SYSTEM", by("p-system"));
  check("nothing recorded → UNKNOWN", by("w-revoked").kind === "UNKNOWN");

  const base = {
    connectionId: "x", provider: "PLAID" as const, ownerUserId: OWNER_A, source: "Chase", removedAt: at(10),
    hasLiveAccounts: false, hasMarker: false, operatorActs: [] as AuditFact[], operatorLabel: () => null,
  };
  const legacy = (minutes: number, extra: Record<string, unknown> = {}): AuditFact =>
    ({ action: AuditAction.CONNECTION_DISCONNECTED, userId: OWNER_A, createdAt: new Date(at(10).getTime() + minutes * 60_000), metadata: { institution: "Chase", ...extra } });
  check("outside the match window → not attributed",
    deriveRemovedBy({ ...base, customerActs: [legacy(REMOVAL_MATCH_WINDOW_MS / 60_000 + 1)] }).kind === "UNKNOWN");
  check("another owner's act never attributes", deriveRemovedBy({ ...base, customerActs: [{ ...legacy(0), userId: OWNER_B }] }).kind === "UNKNOWN");
  check("a different institution never attributes", deriveRemovedBy({ ...base, customerActs: [legacy(0, { institution: "Amex" })] }).kind === "UNKNOWN");
  check("a row that names ANOTHER connection never attributes", deriveRemovedBy({ ...base, customerActs: [legacy(0, { connectionId: "other" })] }).kind === "UNKNOWN");
  check("an ACCOUNT_REMOVE by the owner inside the window → CUSTOMER (INFERRED)",
    deriveRemovedBy({ ...base, customerActs: [{ action: AuditAction.ACCOUNT_REMOVE, userId: OWNER_A, createdAt: at(10), metadata: {} }] }).kind === "CUSTOMER");
  const intent = (id: string, extra: Record<string, unknown> = {}): AuditFact => ({ id, action: AuditAction.CONNECTION_REMOVAL_REQUESTED, userId: null, createdAt: at(10), performedByAdminId: OPERATOR,
    metadata: { result: "SUCCESS", target: { kind: "PLAID_ITEM", id: "x" }, removalReason: "cost", ...extra } });
  check("an INTENT with no outcome (interrupted mid-flight) is still the operator's removal",
    JSON.stringify(deriveRemovedBy({ ...base, customerActs: [], operatorActs: [intent("i1")], operatorLabel: (id) => (id === OPERATOR ? "opsadmin" : null) }))
      === JSON.stringify({ kind: "OPERATOR", operator: "opsadmin", reason: "cost" }));
  check("an INTENT whose outcome FAILED is not a removal", deriveRemovedBy({ ...base, customerActs: [], operatorActs: [intent("i1"),
    { action: AuditAction.CONNECTION_REMOVED_BY_OPERATOR, userId: null, createdAt: at(9), performedByAdminId: OPERATOR, metadata: { result: "FAILURE", target: { id: "x" }, intentAuditId: "i1" } }] }).kind === "UNKNOWN");
  check("an unresolved operator label falls back to the opaque form, never an email",
    deriveRemovedBy({ ...base, customerActs: [], operatorActs: [{ action: AuditAction.CONNECTION_REMOVED_BY_OPERATOR, userId: null, createdAt: at(10), performedByAdminId: "user_xyz123456", metadata: { result: "SUCCESS", target: { id: "x" } } }] })
      .kind === "OPERATOR");
}

console.log("4. the Plaid outcome — and the list agrees with the Provider cleanup widget");
{
  check("CONFIRMED / REMOVED → Confirmed removed", byId(rows, "p-op")!.outcome === "CONFIRMED_REMOVED");
  check("CONFIRMED / ALREADY_GONE → Already gone", byId(rows, "p-legacy")!.outcome === "ALREADY_GONE");
  check("newest UNCONFIRMED → Cleanup owed, retryable, attempts + latest code", (() => {
    const r = byId(rows, "p-cust")!;
    return r.outcome === "CLEANUP_OWED" && r.retryEligible && r.cleanup?.attemptCount === 2 && r.cleanup.latestErrorCode === "RATE_LIMIT";
  })(), byId(rows, "p-cust"));
  check("REVOKED with no marker → Not recorded (status is never cleanup evidence)", byId(rows, "p-webhook")!.outcome === "NOT_RECORDED");
  check("wallets → Not applicable", byId(rows, "w-removed")!.outcome === "NOT_APPLICABLE");

  // THE PIN: the widget's fold and the list's fold, over the same markers.
  const items = input.plaidItems.map((p) => ({ id: p.id, status: p.status, institutionName: p.institutionName, userId: p.userId }));
  const widget = foldCleanupStatus(input.markers, items, NOW);
  const list = queryRemovedConnections(rows, { owner: null, provider: null, outcome: null, page: 1, pageSize: 25 });
  check("cleanup OWED: list === widget", list.cleanup.owedCount === widget.owedCount && list.totals.byOutcome.CLEANUP_OWED === widget.owedCount,
    { list: list.cleanup, widget: { owed: widget.owedCount, confirmed: widget.confirmedCount } });
  check("CONFIRMED removals: list === widget", list.cleanup.confirmedCount === widget.confirmedCount,
    { list: list.cleanup.confirmedCount, widget: widget.confirmedCount });
  check("the owed ITEMS are the same items", list.rows.filter((r) => r.outcome === "CLEANUP_OWED").map((r) => r.id).sort().join() === widget.owed.map((o) => o.plaidItemId).sort().join());
  check("the fixture exercises both (non-vacuous): 2 owed, 4 confirmed", widget.owedCount === 2 && widget.confirmedCount === 4, widget);

  // Single source, by construction: both folds read cleanupVerdicts; neither re-derives "newest wins".
  const cleanupSrc = code("lib/platform/plaid/provider-cleanup.ts");
  const listSrc = code("lib/platform/connections/removed-connections.core.ts");
  check("the cleanup widget's fold counts cleanupVerdicts", /const verdicts = cleanupVerdicts\(rows\);\s*for \(const \[id, v\] of verdicts\)/.test(cleanupSrc));
  check("the list's fold labels rows from cleanupVerdicts", /cleanupVerdicts\(input\.markers\)/.test(listSrc));
  check("the list never compares a marker action itself (no second lifecycle)", !/PLAID_ITEM_REVOCATION_(UN)?CONFIRMED/.test(listSrc));
  check("the list never reads status === REVOKED as cleanup evidence", !/status\s*===\s*["']REVOKED["'][\s\S]{0,80}(CONFIRMED|outcome)/.test(listSrc));
}

console.log("5. filters, paging, parsing");
{
  const q = (o: Partial<Parameters<typeof queryRemovedConnections>[1]>) =>
    queryRemovedConnections(rows, { owner: null, provider: null, outcome: null, page: 1, pageSize: 25, ...o });
  check("provider filter", q({ provider: "WALLET" }).rows.every((r) => r.provider === "WALLET") && q({ provider: "WALLET" }).total === 2);
  check("outcome filter", q({ outcome: "CLEANUP_OWED" }).total === 2);
  check("owner filter (the opaque reference's six characters)", q({ owner: "bbbbbb" }).rows.every((r) => r.ownerRef === "user …bbbbbb") && q({ owner: "bbbbbb" }).total === 4);
  check("totals are over the WHOLE population, not the filter", q({ provider: "WALLET" }).totals.all === rows.length);
  const p1 = q({ pageSize: 4 }), p3 = q({ pageSize: 4, page: 3 });
  check("paging: page 1 = first 4, page 3 = the remainder, total unchanged",
    p1.rows.length === 4 && p3.rows.length === rows.length - 8 && p1.total === rows.length && p1.rows[0].id === rows[0].id && p3.rows[0].id === rows[8].id);
  const parse = (s: string) => parseRemovedConnectionsQuery(new URLSearchParams(s));
  check("defaults: page 1, pageSize 25, no filters", JSON.stringify(parse("")) === JSON.stringify({ query: { owner: null, page: 1, pageSize: 25, provider: null, outcome: null } }));
  check("bad provider / outcome / owner / page / pageSize → error", ["provider=BANK", "outcome=GONE", "owner=abc", "owner=user_owner_bbbbbb", "page=0", "pageSize=101", "page=x"]
    .every((s) => "error" in parse(s)));
  check("the view's url round-trips through the parser",
    JSON.stringify(parse(removedConnectionsUrl({ ...EMPTY_FILTERS, provider: "PLAID", outcome: "CLEANUP_OWED", owner: "aaaaaa", page: 2 }, 3).split("?")[1]))
      === JSON.stringify({ query: { owner: "aaaaaa", page: 2, pageSize: 25, provider: "PLAID", outcome: "CLEANUP_OWED" } }));
  check("ownerTokenOf: only the opaque form yields a token", ownerTokenOf("user …aaaaaa") === "aaaaaa" && ownerTokenOf("—") === null && ownerTokenOf("alice") === null);
  check("confirm copy names the customer AND the institution",
    /Chase/.test(removeConfirmMessage({ owner: "alice", source: "Chase", provider: "PLAID" })) && /alice's account/.test(removeConfirmMessage({ owner: "alice", source: "Chase", provider: "PLAID" })));
}

console.log("6a. inferred attribution is display-only (S2 flag 3)");
{
  // Same rows, same markers — flip one row's attribution to INFERRED and back: nothing actionable moves.
  const recorded = foldRemovedConnections(fixture());
  const noCustomerEvidence = foldRemovedConnections({ ...fixture(), customerActs: [] });
  const strip = (rs: RemovedConnectionRow[]) => rs.map((r) => `${r.id}:${r.outcome}:${r.retryEligible}`).join();
  check("removing every customer act (so INFERRED / RECORDED disappear) changes NO outcome and NO retry eligibility",
    strip(recorded) === strip(noCustomerEvidence) && byId(recorded, "p-legacy")!.removedBy.kind === "CUSTOMER" && byId(noCustomerEvidence, "p-legacy")!.removedBy.kind !== "CUSTOMER");
  const core = code("lib/platform/connections/removed-connections.core.ts");
  const retryLines = core.split("\n").filter((l) => /retryEligible:/.test(l));
  check("source pin: every retryEligible assignment is a function of the outcome / item only, never removedBy",
    retryLines.length === 4 && retryLines.every((l) => !/removedBy|attribution|INFERRED|CUSTOMER/.test(l)), retryLines);
  check("source pin: the only things that ACT (retry POST, remove route, operator removal, retry job) never import the removed-by derivation",
    ["app/api/platform/platform-ops/provider-cleanup/route.ts", "app/api/platform/platform-ops/connections/[id]/remove/route.ts",
      "lib/platform/connections/operator-removal.ts", "jobs/plaid-removal-retry.ts", "lib/notifications/create.ts"]
      .every((f) => !/deriveRemovedBy|removed-connections"|foldRemovedConnections|loadRemovedConnections/.test(code(f))));
  check("the UI's Retry button is gated on retryEligible alone", /\{row\.retryEligible && \(/.test(code("components/platform/widgets/RemovedConnectionsList.tsx")));
}

console.log("6b. the Remove confirmation (S2 flag 1)");
{
  check("Confirm needs the TYPED institution AND a reason", !canConfirmRemoval({ typed: "", source: "Chase", reason: "abuse" })
    && !canConfirmRemoval({ typed: "Chase", source: "Chase", reason: "" })
    && !canConfirmRemoval({ typed: "Chas", source: "Chase", reason: "abuse" })
    && canConfirmRemoval({ typed: "  chase ", source: "Chase", reason: "abuse" }));
  check("whitespace is collapsed, not ignored", canConfirmRemoval({ typed: "Bank  of   America", source: "Bank of America", reason: "cost" })
    && !canConfirmRemoval({ typed: "BankofAmerica", source: "Bank of America", reason: "cost" }));
  check("an empty source can never be confirmed by typing nothing", !canConfirmRemoval({ typed: "", source: "", reason: "abuse" }));
  check("the Plaid consequence line, verbatim", removeConsequenceLine("PLAID") === "Removes the bank link at Plaid; the customer must reconnect; history is kept.");
  const ui = code("components/platform/widgets/RemoveConnectionAction.tsx");
  check("the dialog wires Confirm to canConfirmRemoval and renders the consequence line",
    /confirmDisabled=\{!ready\}/.test(ui) && /canConfirmRemoval\(\{ typed, source: connection\.source, reason \}\)/.test(ui) && /removeConsequenceLine\(connection\.provider\)/.test(ui));
}

console.log("6. Retry reuses the existing path; the boundary holds");
{
  const ui = code("components/platform/widgets/RemovedConnectionsList.tsx");
  const route = code("app/api/platform/platform-ops/removed-connections/route.ts");
  const reader = code("lib/platform/connections/removed-connections.ts");
  check("Retry POSTs to the EXISTING provider-cleanup route", PROVIDER_CLEANUP_RETRY_ROUTE === "/api/platform/platform-ops/provider-cleanup"
    && /fetch\(PROVIDER_CLEANUP_RETRY_ROUTE,\s*\{\s*method:\s*"POST"/.test(ui));
  check("the provider-cleanup POST still reuses the canonical revocation path", /disconnectPlaidItemIfOrphaned\(plaidItemId\)/.test(code("app/api/platform/platform-ops/provider-cleanup/route.ts")));
  check("the list route defines NO mutation (no second retry path)", !/export async function (POST|PATCH|PUT|DELETE)/.test(route));
  check("the list UI calls no Plaid / disconnect code of its own", !/itemRemove|disconnectPlaidItem|disconnectAccounts/.test(ui));
  check("list route: PLATFORM_OPS READ", /requirePlatformAccess\(\s*"PLATFORM_OPS",\s*"READ"\s*\)/.test(route));
  check("reader: fm_system, never the migration principal", /import \{ systemDb \} from "@\/lib\/db"/.test(reader) && !/import \{[^}]*\bdb\b[^}]*\} from "@\/lib\/db"/.test(reader));
  check("reader selects no email / token / credential / address", !/email:\s*true|encryptedToken|credential:\s*true|walletAddress/.test(reader));
  check("owner identity comes ONLY through the Customer Success route (OwnerResolution)", /OwnerResolution/.test(ui) && !/customer-success\/customers/.test(ui));
}

console.log(failures === 0 ? "\n✅ removed connections: derivation, agreement with the cleanup widget, retry reuse and privacy hold." : `\n❌ ${failures} failure(s)`);
if (failures > 0) process.exit(1);
