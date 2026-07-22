/**
 * lib/activity/normalize-sync-issue.test.ts
 *
 * Unit gate for normalizeSyncIssueEvent (Activity Tab event feed, §7):
 *   - unresolved-only filter (resolved → null)
 *   - REMOVED_TOMBSTONE dropped; all internal/reserved kinds dropped
 *   - detail never appears in output (even when present on the row)
 *   - kind → tone mapping (MISSING_ACCOUNT warning, UPSERT_ERROR danger)
 *   - id namespacing (`syncissue:<id>`)
 *
 * House pattern: standalone tsx script, inline `check()` assertions, exit 0/1.
 */

import { normalizeSyncIssueEvent, type SyncIssueRow } from "./normalize-sync-issue";

let passed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; return; }
  failures.push(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
}

const CREATED_AT = new Date("2026-07-09T08:15:00.000Z");

function base(overrides: Partial<SyncIssueRow> = {}): SyncIssueRow {
  return {
    id:        "issue-1",
    kind:      "MISSING_ACCOUNT",
    resolved:  false,
    createdAt: CREATED_AT,
    ...overrides,
  };
}

// ── unresolved-only filter ────────────────────────────────────────────────────
check("resolved=true → null", normalizeSyncIssueEvent(base({ resolved: true })) === null);
check("resolved=false → event", normalizeSyncIssueEvent(base({ resolved: false })) !== null);

// ── kind → tone / title mapping ───────────────────────────────────────────────
{
  const e = normalizeSyncIssueEvent(base({ kind: "MISSING_ACCOUNT" }));
  check("MISSING_ACCOUNT title", e?.title === "Account sync incomplete");
  check("MISSING_ACCOUNT tone warning", e?.tone === "warning");
}
{
  const e = normalizeSyncIssueEvent(base({ kind: "UPSERT_ERROR" }));
  check("UPSERT_ERROR title", e?.title === "Sync error");
  check("UPSERT_ERROR tone danger", e?.tone === "danger");
}

// ── dropped kinds ─────────────────────────────────────────────────────────────
check("REMOVED_TOMBSTONE dropped", normalizeSyncIssueEvent(base({ kind: "REMOVED_TOMBSTONE" })) === null);
for (const kind of [
  "BALANCE_TX_MISMATCH", "REPLAY_ATTEMPTED", "REPLAY_RECOVERED", "REPLAY_FAILED",
  "INSTRUMENT_IDENTITY_CONFLICT", "SOME_FUTURE_KIND",
]) {
  check(`internal/unknown kind ${kind} dropped`, normalizeSyncIssueEvent(base({ kind })) === null);
}

// ── detail never exposed ──────────────────────────────────────────────────────
// Even if a caller hands us a row carrying `detail` (it isn't part of the
// contract type), it must never reach the output. Serialize the whole event and
// assert the sentinel appears nowhere.
{
  const SENTINEL = "plaid-item-abc-secret-merchant-id";
  const rowWithDetail = { ...base({ kind: "UPSERT_ERROR" }), detail: { merchant: SENTINEL, ids: [SENTINEL] } } as SyncIssueRow;
  const out = normalizeSyncIssueEvent(rowWithDetail);
  check("detail sentinel absent from serialized event", !JSON.stringify(out).includes(SENTINEL));
}

// ── id namespacing / date / category ──────────────────────────────────────────
check(
  "id namespaced as syncissue:<id>",
  normalizeSyncIssueEvent(base({ id: "xyz" }))?.id === "syncissue:xyz",
);
check("date is createdAt.toISOString()", normalizeSyncIssueEvent(base())?.date === CREATED_AT.toISOString());
check("category is connection", normalizeSyncIssueEvent(base())?.category === "connection");

// ── Report ────────────────────────────────────────────────────────────────────
if (failures.length > 0) {
  console.error(`\nnormalize-sync-issue: ${failures.length} FAILURE(S) (${passed} checks passed):`);
  for (const f of failures) console.error("  " + f);
  process.exit(1);
}
console.log(`normalize-sync-issue: all ${passed} checks passed.`);
process.exit(0);
