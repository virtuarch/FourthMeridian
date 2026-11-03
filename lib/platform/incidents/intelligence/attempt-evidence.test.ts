/**
 * lib/platform/incidents/intelligence/attempt-evidence.test.ts  (PB-1 Phase 2 — D10 attempt evidence, by subject kind)
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/platform/incidents/intelligence/attempt-evidence.test.ts
 *
 * The loader keys a WALLET incident on its FinancialAccount (RefreshExecution.sourceRef)
 * and a Plaid incident on its item; "why the evidence is missing" is explicit
 * (read / not-needed / unsupported / unreadable) and never hides a row.
 * Synthetic ids only; the ledger read is a fake.
 */

import { attemptEvidenceNote } from "@/components/platform/incidents/incidents-model";
import { deriveIncidentVerdicts } from "./core";
import { loadAttemptEvidence, type IncidentFactsReader } from "./index";
import type { IncidentFacts, IncidentRowFacts } from "./types";

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`); }
}

const DAY = 86_400_000;
const NOW = new Date("2026-11-03T12:00:00Z");
const ago = (d: number) => new Date(NOW.getTime() - d * DAY);
const WALLET_KEY = "v1::WALLET::account:wallet_1::wallet::balance";

function row(id: string, over: Partial<IncidentRowFacts> = {}): IncidentRowFacts {
  return {
    id, kind: "WALLET_SYNC_FAILED", provider: "WALLET", plaidItemId: null, financialAccountId: "wallet_1",
    plaidTransactionId: null, detail: null, resolved: false, incidentKey: WALLET_KEY, previousIncidentId: null,
    createdAt: ago(10), firstOccurredAt: ago(10), lastOccurredAt: ago(9), resolvedAt: null,
    resolutionKind: null, resolutionReasonCode: null, lifecycleState: null, acknowledgedAt: null,
    recoveringSince: null, archivedAt: null, subjectUserId: null, causeStatus: null, causeCode: null,
    evidence: null, occurrenceCount: 1, correlatedOccurrenceCount: 0, ...over,
  };
}

type Latest = Awaited<ReturnType<IncidentFactsReader["latestAttempts"]>>;
function reader(latest: Latest | Error) {
  const calls: Parameters<IncidentFactsReader["latestAttempts"]>[0][] = [];
  return {
    calls,
    client: {
      latestAttempts: (async (args: Parameters<IncidentFactsReader["latestAttempts"]>[0]) => {
        calls.push(args);
        if (latest instanceof Error) throw latest;
        return latest;
      }) as IncidentFactsReader["latestAttempts"],
    },
  };
}

function verdictOf(r: IncidentRowFacts, attempts: Map<string, import("./types").AttemptEvidence>) {
  const facts: IncidentFacts = {
    rows: [r],
    subjects: { items: new Map(), accounts: new Map([["wallet_1", { deletedAt: null, ownerUserId: "u_1", createdByUserId: "u_1" }]]) },
    attempts, scanTruncated: false,
  };
  return deriveIncidentVerdicts(facts, { now: NOW, audience: "PLATFORM_OPS" }).all[0];
}

async function main() {
  console.log("WALLET account-subject incidents read wallet executions (sourceRef)");
  {
    const r = row("w_attempted");
    const { client, calls } = reader([{ plaidItemId: null, sourceRef: "wallet_1", lastAttemptAt: ago(2), lastSkipAt: null }]);
    const ev = await loadAttemptEvidence([r], client, NOW);
    check("the wallet is keyed by its account (sourceRef), not a Plaid item", calls.length === 1
      && calls[0].sourceRefs.join() === "wallet_1" && calls[0].plaidItemIds.length === 0 && calls[0].endpoints.join() === "WALLET_SYNC", calls);
    check("…only after the last failure", calls[0].after.getTime() === ago(9).getTime());
    const e = ev.get("w_attempted");
    check("an attempt since the failure is READ (known)", e?.known === true && e.basis === "read" && e.lastAttemptAt?.getTime() === ago(2).getTime());
    const v = verdictOf(r, ev);
    check("…so the verdict is unverified (attempted since), evidence read", v.freshness === "unverified" && v.recovery.evidenceKnown && v.recovery.evidenceBasis === "read" && v.brokenNow);
  }
  {
    const r = row("w_silent");
    const { client } = reader([]);
    const ev = await loadAttemptEvidence([r], client, NOW);
    const v = verdictOf(r, ev);
    check("D10 — a wallet with NO execution since its failure can reach stale-unverified", v.state === "stale-unverified" && v.freshness === "stale" && !v.brokenNow && v.recovery.evidenceBasis === "read", v);
  }
  {
    const r = row("w_other_wallet");
    const { client } = reader([{ plaidItemId: null, sourceRef: "wallet_2", lastAttemptAt: ago(1), lastSkipAt: ago(1) }]);
    const v = verdictOf(r, await loadAttemptEvidence([r], client, NOW));
    check("another wallet's executions are never this wallet's evidence", v.freshness === "stale");
  }
  {
    const r = row("w_skipped");
    const { client } = reader([{ plaidItemId: null, sourceRef: "wallet_1", lastAttemptAt: null, lastSkipAt: ago(1) }]);
    const v = verdictOf(r, await loadAttemptEvidence([r], client, NOW));
    check("§12 P2.1 — a skipped wallet sync keeps the row broken now (unverified)", v.freshness === "unverified" && v.brokenNow);
  }

  console.log("why evidence is missing is explicit — and never hides a row");
  {
    const inWindow = row("w_current", { lastOccurredAt: ago(1) });
    const { client, calls } = reader([]);
    const ev = await loadAttemptEvidence([inWindow], client, NOW);
    const v = verdictOf(inWindow, ev);
    check("inside its window: no read, basis not-needed (not 'could not be read')", calls.length === 0 && v.recovery.evidenceBasis === "not-needed" && v.freshness === "current");
    check("…and the drawer adds no evidence warning", attemptEvidenceNote(v.recovery.evidenceBasis) === null);

    const noSubject = row("w_noacct", { financialAccountId: null, incidentKey: null });
    const ev2 = await loadAttemptEvidence([noSubject], reader([]).client, NOW);
    const v2 = verdictOf(noSubject, ev2);
    check("a wallet incident naming no account: unsupported, still broken now", v2.recovery.evidenceBasis === "unsupported" && v2.brokenNow && v2.freshness === "unverified");
    check("…worded 'isn't tracked for this provider yet'", /isn't tracked for this provider yet/.test(attemptEvidenceNote(v2.recovery.evidenceBasis) ?? ""));

    const warn = console.warn;
    const logged: string[] = [];
    console.warn = (...a: unknown[]) => { logged.push(a.map(String).join(" ")); };
    const r3 = row("w_fail");
    let ev3;
    try { ev3 = await loadAttemptEvidence([r3], reader(new Error("boom wallet_1")).client, NOW); } finally { console.warn = warn; }
    const v3 = verdictOf(r3, ev3);
    check("a failed read: unreadable, still broken now, not alertable", v3.recovery.evidenceBasis === "unreadable" && v3.brokenNow && !v3.alertable);
    check("…logged once, without ids or the error text", logged.length === 1 && !logged[0].includes("wallet_1") && !logged[0].includes("boom"), logged);
    check("…worded 'could not be read'", /could not be read/.test(attemptEvidenceNote(v3.recovery.evidenceBasis) ?? ""));
  }

  console.log("Plaid incidents still key on the item; one aggregate per endpoint set");
  {
    const p1 = row("p_tx", { provider: "PLAID", kind: "UPSERT_ERROR", plaidItemId: "item_1", financialAccountId: null, incidentKey: null, lastOccurredAt: ago(20) });
    const w1 = row("w_bal");
    const { client, calls } = reader([
      { plaidItemId: "item_1", sourceRef: null, lastAttemptAt: ago(3), lastSkipAt: null },
      { plaidItemId: null, sourceRef: "wallet_1", lastAttemptAt: null, lastSkipAt: null },
    ]);
    const ev = await loadAttemptEvidence([p1, w1], client, NOW);
    check("two endpoint sets ⇒ two aggregate reads, each with its own subjects",
      calls.length === 2 && calls.some((c) => c.plaidItemIds.join() === "item_1" && c.endpoints.join() === "TRANSACTIONS")
      && calls.some((c) => c.sourceRefs.join() === "wallet_1" && c.endpoints.join() === "WALLET_SYNC"), calls);
    check("the Plaid row reads its item's attempt", ev.get("p_tx")?.lastAttemptAt?.getTime() === ago(3).getTime());
  }

  if (failures) { console.error(`\nattempt-evidence.test: ${failures} failure(s).`); process.exit(1); }
  console.log("\nattempt-evidence.test: all passed.");
}

void main();
