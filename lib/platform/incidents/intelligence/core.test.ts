/**
 * lib/platform/incidents/intelligence/core.test.ts  (PB-1 Phase 2 — the deterministic core, one block per D-rule)
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/platform/incidents/intelligence/core.test.ts
 *
 * Synthetic ids only. Pure: no DB, no clock (every call passes `now`).
 */

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { classifySyncIssue } from "@/lib/platform/sync-issue-semantics";
import { buildResolutionEvidence, digestStoredEvidence } from "../evidence";
import { deriveIncidentVerdicts, normaliseVerdict, WIDESPREAD_MIN_SUBJECTS } from "./core";
import { STALE_WINDOWS_MS } from "./staleness";
import type { AttemptEvidence, CsIncidentVerdict, IncidentAudience, IncidentFacts, IncidentRowFacts, IncidentVerdict } from "./types";

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`); }
}

const DAY = 86_400_000;
const NOW = new Date("2026-11-03T12:00:00Z");
const ago = (d: number) => new Date(NOW.getTime() - d * DAY);
const KEY = (scope: string, op: string, provider = "PLAID", domain = "transactions") => `v1::${provider}::${scope}::${domain}::${op}`;
const SECRET = "provider-free-text-should-never-leak";

function row(id: string, over: Partial<IncidentRowFacts> = {}): IncidentRowFacts {
  return {
    id, kind: "UPSERT_ERROR", provider: "PLAID", plaidItemId: "item_a", financialAccountId: null,
    plaidTransactionId: null, detail: { message: SECRET }, resolved: false, incidentKey: null, previousIncidentId: null,
    createdAt: ago(2), firstOccurredAt: ago(2), lastOccurredAt: ago(1), resolvedAt: null,
    resolutionKind: null, resolutionReasonCode: null, lifecycleState: null, acknowledgedAt: null,
    recoveringSince: null, archivedAt: null, subjectUserId: null, causeStatus: null, causeCode: null,
    evidence: null, occurrenceCount: 1, correlatedOccurrenceCount: 0, ...over,
  };
}

function facts(rows: IncidentRowFacts[], over: Partial<IncidentFacts> = {}): IncidentFacts {
  return {
    rows,
    subjects: {
      items: new Map([
        ["item_a", { status: "ACTIVE", userId: "u_alice" }],
        ["item_b", { status: "ACTIVE", userId: "u_bob" }],
        ["item_revoked", { status: "REVOKED", userId: "u_alice" }],
      ]),
      accounts: new Map([
        ["acct_live", { deletedAt: null, ownerUserId: "u_alice", createdByUserId: "u_alice" }],
        ["acct_soft", { deletedAt: ago(3), ownerUserId: "u_alice", createdByUserId: "u_alice" }],
        ["acct_manual", { deletedAt: null, ownerUserId: null, createdByUserId: "u_bob" }],
        ["wallet_1", { deletedAt: null, ownerUserId: "u_bob", createdByUserId: "u_bob" }],
      ]),
    },
    scanTruncated: false,
    ...over,
  };
}

function derive(f: IncidentFacts, audience: IncidentAudience = "PLATFORM_OPS"): IncidentVerdict[] {
  return deriveIncidentVerdicts(f, { now: NOW, audience }).all;
}
const one = (r: IncidentRowFacts, over: Partial<IncidentFacts> = {}, audience: IncidentAudience = "PLATFORM_OPS") => derive(facts([r], over), audience)[0];
const attempts = (id: string, e: AttemptEvidence) => ({ attempts: new Map([[id, e]]) });
const KNOWN_NONE: AttemptEvidence = { known: true, lastAttemptAt: null, lastSkipAt: null };

console.log("baseline — a live condition is broken now and alertable");
{
  const v = one(row("r1"));
  check("active, brokenNow, alertable, current", v.state === "active" && v.brokenNow && v.alertable && v.freshness === "current", v);
  check("severity critical (UPSERT_ERROR, transactions)", v.severity === "critical" && v.effectiveSeverity === "critical");
  check("available actions: acknowledge + resolve", JSON.stringify(v.availableActions) === '["acknowledge","resolve"]');
}

console.log("D1 — open is DERIVED state, never raw resolved=false");
{
  const tomb = one(row("t", { kind: "REMOVED_TOMBSTONE" }));
  check("an unresolved tombstone is evidence, not broken now", tomb.rowClass === "evidence" && !tomb.brokenNow && !tomb.alertable && tomb.state === "resolved" && tomb.availableActions.length === 0);
  const sup = one(row("s", { kind: "BALANCE_TX_MISMATCH", plaidItemId: null, financialAccountId: "acct_live", detail: { basis: "pending" } }));
  check("an unresolved pre-fix mismatch is superseded, not broken now", sup.rowClass === "superseded" && !sup.brokenNow);
  check("normalised state names the row class", normaliseVerdict(tomb).state === "evidence" && normaliseVerdict(sup).state === "superseded");
  const orphan = one(row("o", { plaidItemId: "item_missing" }));
  check("an unresolved row on a missing item is closed connection-removed (derived)", !orphan.brokenNow && orphan.state === "resolved" && orphan.closure === "connection-removed" && orphan.closureDerived && orphan.subjectState === "MISSING");
}

console.log("D2 — ONE referent rule (subjects-core): soft-deleted / missing = removed");
{
  const soft = one(row("a", { plaidItemId: null, financialAccountId: "acct_soft" }));
  check("a soft-deleted account closes the incident (DELETED), never 'recovered'", soft.closure === "connection-removed" && soft.subjectState === "DELETED" && !soft.brokenNow);
  const hard = one(row("b", { plaidItemId: "item_a", financialAccountId: "acct_hard_gone" }));
  check("item live + account row missing ⇒ removed (MISSING)", hard.closure === "connection-removed" && hard.subjectState === "MISSING");
  const live = one(row("c", { plaidItemId: "item_a", financialAccountId: "acct_live" }));
  check("item live + account live ⇒ open", live.brokenNow && live.subjectState === "LIVE");
  const occ = one(row("d"), { subjects: { ...facts([]).subjects, occurrenceAccounts: new Map([["d", ["acct_soft"]]]) } });
  check("§12 P2.2 — an item-scoped episode whose only named account is removed is closed", occ.closure === "connection-removed" && occ.subjectState === "DELETED");
  const unscoped = one(row("e", { plaidItemId: null, financialAccountId: null }));
  check("a row naming no subject stays open (UNSCOPED)", unscoped.brokenNow && unscoped.subjectState === "UNSCOPED");
  check("a derived closure offers no action (S7 persists it first)", soft.availableActions.length === 0);
}

console.log("D2b — a REVOKED item's incidents read 'connection removed'");
{
  const v = one(row("r", { plaidItemId: "item_revoked" }));
  check("closed, REVOKED, not broken now, not alertable", v.state === "resolved" && v.closure === "connection-removed" && v.subjectState === "REVOKED" && !v.brokenNow && !v.alertable);
}

console.log("D3 — classification receives the full fact set");
{
  const r = row("x", { detail: { stage: "investment-events-fetch" }, plaidTransactionId: "txn_1" });
  const v = one(r);
  const full = classifySyncIssue({ kind: r.kind, provider: r.provider, detail: r.detail, plaidTransactionId: "txn_1" });
  const partial = classifySyncIssue({ kind: r.kind, provider: r.provider, detail: r.detail });
  check("the fixture really differs without plaidTransactionId", full.domain !== partial.domain || full.severity !== partial.severity, { full, partial });
  check("the verdict matches the FULL classification", v.domain === full.domain && v.severity === full.severity, { domain: v.domain, severity: v.severity });
}

console.log("D4 — ONE attribution rule; identity only on the CUSTOMER_SUCCESS tier");
{
  const rows = [
    row("stamped", { subjectUserId: "u_bob", plaidItemId: "item_a" }),
    row("item", { plaidItemId: "item_a" }),
    row("owner", { plaidItemId: null, financialAccountId: "acct_live" }),
    row("creator", { plaidItemId: null, financialAccountId: "acct_manual" }),
    row("none", { plaidItemId: null, financialAccountId: null }),
  ];
  const cs = derive(facts(rows), "CUSTOMER_SUCCESS") as CsIncidentVerdict[];
  const who = Object.fromEntries(cs.map((v) => [v.id, v.subjectUserId]));
  check("subjectUserId (Phase 1) wins over the item owner", who.stamped === "u_bob");
  check("else the item's user", who.item === "u_alice");
  check("else the account ownerUserId", who.owner === "u_alice");
  check("else createdByUserId (a manual account is attributed)", who.creator === "u_bob");
  check("no subject ⇒ null", who.none === null);
  for (const a of ["PLATFORM_OPS", "SYSTEM"] as const) {
    const vs = derive(facts(rows), a);
    check(`${a} verdicts have NO subjectUserId key`, vs.every((v) => !("subjectUserId" in v)) && !JSON.stringify(vs).includes("u_bob"));
    check(`${a} normalised verdicts carry no subjectUserId`, vs.map(normaliseVerdict).every((n) => !("subjectUserId" in n)));
  }
  check("CS normalised verdicts carry it", cs.map(normaliseVerdict).every((n) => "subjectUserId" in n));
}

console.log("D4 — unattributed is null, never an empty string");
{
  const base = facts([]).subjects;
  const subjects = {
    ...base,
    items: new Map([...base.items, ["item_ownerless", { status: "ACTIVE", userId: null }], ["item_blank", { status: "ACTIVE", userId: "" }]]),
    accounts: new Map([...base.accounts, ["acct_blank", { deletedAt: null, ownerUserId: "", createdByUserId: "" }]]),
  };
  const rows = [
    row("ownerless", { plaidItemId: "item_ownerless" }),
    row("blank_item", { plaidItemId: "item_blank" }),
    row("blank_acct", { plaidItemId: null, financialAccountId: "acct_blank" }),
    row("blank_stamp", { subjectUserId: "", plaidItemId: "item_ownerless" }),
    row("ownerless_item_owned_acct", { plaidItemId: "item_ownerless", financialAccountId: "acct_live" }),
  ];
  const cs = derive(facts(rows, { subjects }), "CUSTOMER_SUCCESS") as CsIncidentVerdict[];
  const who = Object.fromEntries(cs.map((v) => [v.id, v.subjectUserId]));
  check("an ownerless item gives CS subjectUserId null", who.ownerless === null && "subjectUserId" in cs.find((v) => v.id === "ownerless")!);
  check("blank owner ids are unattributed (null), never \"\"", who.blank_item === null && who.blank_acct === null && who.blank_stamp === null);
  check("an ownerless item falls through to the account owner (D4 order)", who.ownerless_item_owned_acct === "u_alice");
  check("no CS verdict ever carries an empty subjectUserId", cs.every((v) => v.subjectUserId !== ""));
  const ops = derive(facts(rows, { subjects }), "PLATFORM_OPS");
  check("Platform Ops still has no subjectUserId key", ops.every((v) => !("subjectUserId" in v)) && ops.map(normaliseVerdict).every((n) => !("subjectUserId" in n)));
}

console.log("D5 — every set says whether it is complete");
{
  const s = deriveIncidentVerdicts(facts([row("a"), row("b")], { scanTruncated: true }), { now: NOW, audience: "PLATFORM_OPS" });
  check("truncated is carried; scanned counts the rows read", s.truncated === true && s.scanned === 2);
  const t = deriveIncidentVerdicts(facts([row("a")]), { now: NOW, audience: "PLATFORM_OPS" });
  check("untruncated scan says so", t.truncated === false && t.scanned === 1);
}

console.log("D6 / D7 — creation date never hides an open incident; since = first, recency = last");
{
  const v = one(row("old", { createdAt: ago(40), firstOccurredAt: ago(40), lastOccurredAt: ago(1) }));
  check("created 40 days ago, failing yesterday ⇒ broken now and current", v.brokenNow && v.freshness === "current");
  check("firstSeenAt = firstOccurredAt, lastSeenAt = lastOccurredAt", v.firstSeenAt === ago(40).toISOString() && v.lastSeenAt === ago(1).toISOString());
  const legacy = one(row("leg", { createdAt: ago(5), firstOccurredAt: null, lastOccurredAt: null }));
  check("legacy rows fall back to createdAt", legacy.firstSeenAt === ago(5).toISOString() && legacy.lastSeenAt === ago(5).toISOString());
  const vs = derive(facts([row("older", { lastOccurredAt: ago(3) }), row("newer", { lastOccurredAt: ago(1) })]));
  check("same priority ⇒ ordered by lastSeenAt desc", vs[0].id === "newer" && vs[1].id === "older");
}

console.log("D8 — episode identity = incidentKey (+ previousIncidentId)");
{
  const k = KEY("item:item_a", "transaction-persist");
  const vs = derive(facts([
    row("g1", { incidentKey: k, resolved: true, resolutionKind: "AUTOMATIC_RECOVERY", resolvedAt: ago(8), lastOccurredAt: ago(9) }),
    row("g2", { incidentKey: k, previousIncidentId: "g1", lastOccurredAt: ago(1) }),
    row("nokey"),
  ]));
  const by = Object.fromEntries(vs.map((v) => [v.id, v]));
  check("episodeKey = incidentKey; legacy rows get legacy:<id>", by.g1.episodeKey === k && by.g2.episodeKey === k && by.nokey.episodeKey === "legacy:nokey");
  check("generation follows the previousIncidentId chain", by.g1.recurrence.generation === 1 && by.g2.recurrence.generation === 2);
  check("reopen refused while the key has an open episode", !by.g1.availableActions.includes("reopen"));
  check("the registered operation is emitted with its label", by.g2.operation === "transaction-persist" && typeof by.g2.operationLabel === "string");
  const dup = derive(facts([row("d_old", { incidentKey: k, lastOccurredAt: ago(3) }), row("d_new", { incidentKey: k, lastOccurredAt: ago(1) })]));
  const d = Object.fromEntries(dup.map((v) => [v.id, v]));
  check("legacy duplicate open rows fold onto the newest; the folded one is not broken now",
    d.d_old.duplicateOf === "d_new" && !d.d_old.brokenNow && !d.d_old.alertable && d.d_new.brokenNow && d.d_new.duplicateOf === null);
  const closedAlone = one(row("c", { incidentKey: k, resolved: true, resolutionKind: "OPERATOR_RESOLVED", resolvedAt: ago(1) }));
  check("an operator-closed episode with no open successor may be reopened", JSON.stringify(closedAlone.availableActions) === '["reopen"]' && closedAlone.closure === "operator");
  const unreg = one(row("u", { incidentKey: KEY("item:item_a", "unregistered:some-stage") }));
  check("an unregistered operation is never emitted as `operation` / label (only inside the opaque episodeKey)",
    unreg.operation === null && unreg.operationLabel === null && unreg.spread.groupKey.endsWith("::unknown"));
  const rel = derive(facts([row("x1"), row("x2")], { relations: [{ fromIncidentId: "x1", toIncidentId: "x2", kind: "SAME_ROOT_CAUSE" }] }));
  check("relations are carried both ways", rel.every((v) => v.recurrence.relatedIncidentIds.length === 1));
}

console.log("D9 — severity is emitted; alertable does not filter it (each consumer keeps its own filter)");
{
  const err = one(row("i", { detail: { stage: "investment-events-fetch" } }));
  check("a non-critical live incident is emitted with its severity and is alertable", err.severity === "error" && err.alertable);
  check("normalised severity present (alerts read alertable && critical)", normaliseVerdict(err).severity === "error");
}

console.log("D10 — the STALE rule, applied once");
{
  const old = { lastOccurredAt: ago(30), firstOccurredAt: ago(30), createdAt: ago(30) };
  const stale = one(row("s", old), attempts("s", KNOWN_NONE));
  check("past window, neither attempted nor skipped ⇒ stale-unverified, not broken now, never alerts",
    stale.state === "stale-unverified" && stale.freshness === "stale" && !stale.brokenNow && !stale.alertable, stale);
  check("…and still offers acknowledge / resolve (it is not resolved)", stale.availableActions.includes("resolve") && stale.closure === null);
  const unknown = one(row("u", old));
  check("evidence UNKNOWN never hides a row: unverified, broken now, lower severity, not alertable",
    unknown.freshness === "unverified" && unknown.brokenNow && !unknown.alertable && unknown.effectiveSeverity === "error" && unknown.severity === "critical");
  const tried = one(row("t", old), attempts("t", { known: true, lastAttemptAt: ago(2), lastSkipAt: null }));
  check("attempted since ⇒ unverified (broken now)", tried.freshness === "unverified" && tried.brokenNow && !tried.alertable);
  const skipped = one(row("k", old), attempts("k", { known: true, lastAttemptAt: null, lastSkipAt: ago(2) }));
  check("§12 P2.1 — SKIPPED since ⇒ unverified, never hidden", skipped.freshness === "unverified" && skipped.brokenNow);
  const before = one(row("b", old), attempts("b", { known: true, lastAttemptAt: ago(31), lastSkipAt: ago(31) }));
  check("attempts BEFORE the last occurrence prove nothing ⇒ stale", before.freshness === "stale");
  check("recovery carries the evidence instants", tried.recovery.lastAttemptAt === ago(2).toISOString() && tried.recovery.evidenceKnown);
  const plaid13 = one(row("p", { lastOccurredAt: ago(13) }), attempts("p", KNOWN_NONE));
  check(`Plaid window ${STALE_WINDOWS_MS.plaidItem / DAY} d: 13 days silent is current`, plaid13.freshness === "current" && plaid13.alertable);
  const wallet8 = one(row("w", { provider: "WALLET", kind: "UPSERT_ERROR", plaidItemId: null, financialAccountId: "wallet_1", lastOccurredAt: ago(8) }), attempts("w", KNOWN_NONE));
  check(`wallet window ${STALE_WINDOWS_MS.wallet / DAY} d: 8 days silent is stale`, wallet8.freshness === "stale");
  const user = one(row("m", { incidentKey: KEY("item:item_a", "investment-import-repair", "PLAID", "imports"), lastOccurredAt: ago(20) }), attempts("m", KNOWN_NONE));
  check(`user-triggered window ${STALE_WINDOWS_MS.userTriggered / DAY} d: 20 days silent is current`, user.freshness === "current");
  check("the windows are the one named constant (14 / 7 / 30 d)",
    STALE_WINDOWS_MS.plaidItem === 14 * DAY && STALE_WINDOWS_MS.wallet === 7 * DAY && STALE_WINDOWS_MS.userTriggered === 30 * DAY);
}

console.log("lifecycle states");
{
  const ack = one(row("a", { lifecycleState: "ACKNOWLEDGED", acknowledgedAt: ago(1) }));
  check("acknowledged: broken now, alertable, resolve only", ack.state === "acknowledged" && ack.brokenNow && ack.alertable && JSON.stringify(ack.availableActions) === '["resolve"]');
  const rec = one(row("r", { lifecycleState: "RECOVERING", recoveringSince: ago(1) }));
  check("recovering: broken now, NOT alertable", rec.state === "recovering" && rec.brokenNow && !rec.alertable);
  const recOld = one(row("ro", { lifecycleState: "RECOVERING", recoveringSince: ago(1), lastOccurredAt: ago(30) }), attempts("ro", KNOWN_NONE));
  check("a recovering row is never re-labelled stale", recOld.state === "recovering" && recOld.brokenNow);
  const closures = derive(facts([
    row("k1", { resolved: true, resolutionKind: "AUTOMATIC_RECOVERY" }),
    row("k2", { resolved: true, resolutionKind: "SUBJECT_REMOVED" }),
    row("k3", { resolved: true, resolutionKind: null }),
  ]));
  const c = Object.fromEntries(closures.map((v) => [v.id, v]));
  check("persisted kinds map to closures", c.k1.closure === "recovered" && c.k2.closure === "connection-removed" && c.k3.closure === "legacy-resolved" && !c.k1.closureDerived);
  check("a kind-less legacy closure has no reopen rule", c.k3.availableActions.length === 0);
  check("closed rows rank after open rows", derive(facts([row("k1", { resolved: true, resolutionKind: "AUTOMATIC_RECOVERY" }), row("open")]))[0].id === "open");
}

console.log("spread — isolated vs widespread (identity-free count)");
{
  const vs = derive(facts([row("a1", { plaidItemId: "item_a" }), row("a2", { plaidItemId: "item_a" }), row("b1", { plaidItemId: "item_b" })]));
  check(`≥ ${WIDESPREAD_MIN_SUBJECTS} distinct subjects in one group ⇒ widespread`, vs.every((v) => v.spread.spread === "widespread" && v.spread.affectedSubjects === 2));
  check("groupKey is provider::domain::operation, never a subject id", vs.every((v) => v.spread.groupKey === "PLAID::transactions::unknown"));
  const iso1 = derive(facts([row("a1"), row("a2")]));
  check("one subject ⇒ isolated", iso1.every((v) => v.spread.spread === "isolated" && v.spread.affectedSubjects === 1));
}

console.log("recovery evidence — digest only, never the raw column");
{
  const stored = buildResolutionEvidence({
    rule: "WALLET_PRICE_RECOVERY",
    facts: [
      { source: "RefreshEndpointResult", executionId: "exec_1", endpoint: "VALUATION", status: "SUCCEEDED", completedAt: ago(1).toISOString() },
      { source: "RefreshEndpointResult", executionId: "exec_2", endpoint: "VALUATION", status: "SKIPPED", skipReason: "BUDGET", completedAt: ago(2).toISOString() },
    ],
  });
  const digest = digestStoredEvidence(stored);
  check("digest counts proof / non-proof and gates mayAdvance", !!digest && digest.proofCount === 1 && digest.nonProofCount === 1 && digest.mayAdvance && digest.lastProofAt === ago(1).toISOString());
  check("digest carries no execution id and no skip reason", !JSON.stringify(digest).includes("exec_") && !JSON.stringify(digest).includes("BUDGET"));
  const skipOnly = digestStoredEvidence(buildResolutionEvidence({ rule: "R1", facts: [{ source: "RefreshEndpointResult", executionId: null, endpoint: "VALUATION", status: "SKIPPED", completedAt: null }] }));
  check("a SKIPPED-only record never may-advance", !!skipOnly && skipOnly.proofCount === 0 && !skipOnly.mayAdvance);
  check("non-conforming stored evidence digests to null", digestStoredEvidence({ rule: "lower case!", proof: [{ message: SECRET }] }) === null && digestStoredEvidence("x") === null);
  const v = one(row("e", { evidence: digest }));
  check("the verdict's recovery reads the digest", v.recovery.proofCount === 1 && v.recovery.mayAdvance);
}

console.log("metamorphic (§13.3 step 4)");
{
  const rows = [
    row("m1"), row("m2", { kind: "REMOVED_TOMBSTONE" }), row("m3", { plaidItemId: "item_revoked" }),
    row("m4", { lastOccurredAt: ago(30) }), row("m5", { resolved: true, resolutionKind: "AUTOMATIC_RECOVERY" }),
    row("m6", { plaidItemId: null, financialAccountId: "acct_manual", plaidTransactionId: "txn_9" }),
  ];
  const f1 = facts(rows, attempts("m4", KNOWN_NONE));
  const f2 = facts([...rows].reverse(), attempts("m4", KNOWN_NONE));
  for (const a of ["PLATFORM_OPS", "CUSTOMER_SUCCESS", "SYSTEM"] as const) {
    const out1 = JSON.stringify(derive(f1, a));
    check(`${a}: input-order independent`, out1 === JSON.stringify(derive(f2, a)));
    check(`${a}: idempotent`, out1 === JSON.stringify(derive(f1, a)));
    check(`${a}: no detail, no provider text, no transaction id in any output`,
      !out1.includes(SECRET) && !out1.includes("txn_9") && !out1.includes('"detail"') && !out1.includes("plaidTransactionId"));
  }
  check("facts are not mutated (resolved stays false on the stale row)", rows[3].resolved === false);
  check("every row gets exactly one verdict", derive(f1).length === rows.length);
  const archived = deriveIncidentVerdicts(facts([row("live")], {
    archived: [{
      incidentId: "arch_1", incidentKey: null, provider: "PLAID", kind: "UPSERT_ERROR", operation: null, plaidItemId: "item_a",
      financialAccountId: null, subjectUserId: "u_alice", previousIncidentId: null, firstOccurredAt: ago(90), lastOccurredAt: ago(80),
      resolvedAt: ago(79), resolutionKind: "AUTOMATIC_RECOVERY", resolutionReasonCode: null, causeStatus: null, causeCode: null,
      occurrenceCount: 3, archivedAt: ago(10),
    }],
  }), { now: NOW, audience: "PLATFORM_OPS" }).all;
  const arch = archived.find((v) => v.id === "arch_1")!;
  check("archived summaries are verdicts: state archived, never broken now, identity-free", arch.state === "archived" && !arch.brokenNow && !("subjectUserId" in arch) && !JSON.stringify(arch).includes("u_alice"));
}

console.log("static pins");
{
  const ROOT = process.cwd();
  const DIR = "lib/platform/incidents/intelligence";
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const files = readdirSync(path.join(ROOT, DIR)).filter((f) => /\.ts$/.test(f) && !/\.test\.ts$/.test(f));
  const src = (f: string) => strip(readFileSync(path.join(ROOT, DIR, f), "utf8"));
  check("core.ts is pure: no db, no server-only, no clock", !/@\/lib\/db|server-only|new Date\(\)|Date\.now\(/.test(src("core.ts")));
  check("the core writes nothing", files.every((f) => !/\.(create|createMany|update|updateMany|upsert|delete|deleteMany|\$executeRaw)\w*\(/.test(src(f))));
  check("the STALE windows are defined once (staleness.ts)", files.filter((f) => /STALE_WINDOWS_MS\s*=/.test(src(f))).join() === "staleness.ts");
  check("freshness is computed only in core.ts", files.filter((f) => /(?<!function )incidentFreshness\(/.test(src(f))).join() === "core.ts");
}

if (failures) { console.error(`\ncore.test: ${failures} failure(s).`); process.exit(1); }
console.log("\ncore.test: all passed.");
