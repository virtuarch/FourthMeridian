/**
 * scripts/audit-transfer-identification.ts
 *
 * v2.6-XFER-1 — the DISAMBIGUATION rung's standing safety check. READ-ONLY.
 *
 * Built first as a dry-run instrument (measure the rung before implementing it),
 * now REQUIRED in CI: it re-derives every identification narrowing through the
 * authority's OWN helper and fails the build if the rung ever names an account
 * that contradicts one an approved repair already persisted.
 *
 *   npx tsx --env-file=.env.local scripts/audit-transfer-identification.ts
 *
 * ── The gap ─────────────────────────────────────────────────────────────────
 *
 * `legsQualify` uses an extracted account mask SUBTRACTIVELY: a leg naming an
 * account that is not the other side is disqualified. It cannot PREFER a leg
 * that names the right one. So among surviving candidates, "names the
 * counterparty by mask" and "names nothing" count the same, and the ladder sees
 * a tie where the evidence has a winner.
 *
 * Live example — three AMEX savings→checking transfers ($6,500):
 *
 *   source   AMEX High Yield Savings (mask 5336)  −500  "Requested transfer to
 *            AMEX checking account"
 *   cand A   AMEX Rewards Checking  +500  "Internal Transfer Credit: Savings -5336"
 *   cand B   AMEX Platinum Card®    +500  "MOBILE PAYMENT - THANK YOU"
 *
 * Candidate A names mask 5336 — which IS the source account. Candidate B names
 * nothing; it is a genuine card payment that coincides in amount, day and
 * institution. Candidates span checking + debt ⇒ TYPE_AMBIGUOUS /
 * CANDIDATES_SPAN_TYPES ⇒ UNRESOLVED_TRANSFER.
 *
 * ── The proposed rung ───────────────────────────────────────────────────────
 *
 *   Among QUALIFYING candidates, a leg that positively identifies the source
 *   account outranks a leg that identifies nothing.
 *
 * It is a NARROWING, not a new level: the identified subset becomes the
 * candidate set and the existing ladder runs unchanged on it, so the outcome is
 * still ACCOUNT_CERTAIN (mutually unique) or ACCOUNT_CERTAIN_LEG_AMBIGUOUS
 * (pigeonhole) or a refusal. It can only ever remove a candidate that survived
 * `legsQualify` — never invent one.
 *
 * ⚠️ It applies ONLY when the identified subset is a strict, non-empty subset.
 * If two candidates both identify the source, nothing is preferred and the
 * existing rungs decide. Identification breaks ties; it does not create claims.
 *
 * ── What this script proves before any code changes ─────────────────────────
 *
 * It calls the REAL `resolveDestinationEvidence` twice per leg — once with the
 * full qualifying set, once with the narrowed set — so the narrowing is the only
 * variable. It then reports every level change and, critically, every
 * CONTRADICTION against a counterparty already persisted by an approved repair.
 */

import { db } from "@/lib/db";
import { resolveLifecycle } from "@/lib/transactions/lifecycle";
import { plaidTransferEvidence } from "@/lib/transactions/plaid-transfer-evidence";
import { extractProviderLinks } from "@/lib/transactions/provider-link-extract";
import {
  resolveDestinationEvidence, legsQualify, maturityForEvidence, narrowByIdentification,
  type TransferLeg, type DestinationCandidate,
} from "@/lib/transactions/transfer-maturation";

const bar = (s: string) => console.log(`\n${"═".repeat(78)}\n${s}\n${"═".repeat(78)}`);
const money = (n: number) => `$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

async function main(): Promise<void> {
  console.log("\n[AUDIT] Transfer identification rung — DRY RUN, nothing is written\n");

  const accounts = await db.financialAccount.findMany({
    where: { deletedAt: null },
    select: { id: true, name: true, type: true, ownerUserId: true, mask: true, institutionId: true },
  });
  const A = new Map(accounts.map((a) => [a.id, a]));

  // Mask index, per owner — the same shape RelationshipResolver builds. A mask
  // held by more than one account is present with ALL of them so extraction
  // ABSTAINS rather than picking.
  const maskToAccountIds = new Map<string, string[]>();
  for (const a of accounts) {
    if (!a.mask) continue;
    const l = maskToAccountIds.get(a.mask);
    if (l) l.push(a.id); else maskToAccountIds.set(a.mask, [a.id]);
  }

  const all = await db.transaction.findMany({
    select: {
      id: true, financialAccountId: true, date: true, economicDate: true, amount: true,
      currency: true, flowType: true, deletedAt: true, pending: true, settlementState: true,
      counterpartyAccountId: true, merchant: true, description: true,
      plaidTransactionId: true, pendingTransactionRef: true, pfcDetailed: true,
    },
  });
  const liveRefs = new Set(
    all.filter((r) => r.deletedAt == null && r.pendingTransactionRef).map((r) => r.pendingTransactionRef!),
  );
  const lc = (t: (typeof all)[number]) => resolveLifecycle({
    settlementState: t.settlementState, pending: t.pending, deletedAt: t.deletedAt,
    hasLivePostedSuccessor: t.plaidTransactionId ? liveRefs.has(t.plaidTransactionId) : false,
  });
  const shaped = (f: string | null) =>
    f === null || f === "TRANSFER" || f === "DEBT_PAYMENT" || f === "UNKNOWN";
  const corpus = all.filter((t) => shaped(t.flowType) && !lc(t).superseded);

  const legs: TransferLeg[] = corpus.map((t) => {
    const acct = A.get(t.financialAccountId ?? "");
    const links = extractProviderLinks(`${t.merchant ?? ""} ${t.description ?? ""}`, {
      institutionId: acct?.institutionId ?? null,
      maskToAccountIds,
      selfAccountId: t.financialAccountId ?? "",
    });
    const ev = plaidTransferEvidence({ pfcDetailed: t.pfcDetailed, amount: t.amount, name: t.merchant });
    return {
      id: t.id, accountId: t.financialAccountId ?? "",
      accountType: acct?.type ?? "other", ownerId: acct?.ownerUserId ?? "",
      amount: t.amount, currency: t.currency ?? null,
      dateMs: (t.economicDate ?? t.date).getTime(),
      superseded: lc(t).superseded,
      providerLinkKey: links.correlation?.linkKey ?? null,
      maskedDestinationAccountId: links.maskedAccountId ?? null,
      railType: ev.railType ?? null,
      movementForm: ev.movementForm ?? null,
    };
  });
  const rowOf = new Map(corpus.map((t, i) => [t.id, { t, leg: legs[i] }]));

  const withMask = legs.filter((l) => l.maskedDestinationAccountId).length;
  console.log(`  legs in the matching corpus            : ${legs.length}`);
  console.log(`  ...carrying an extracted account mask  : ${withMask}`);

  // ── Per-leg: current verdict vs narrowed verdict ──────────────────────────
  bar("LEVEL CHANGES UNDER THE IDENTIFICATION RUNG");

  interface Change { id: string; from: string; to: string; matFrom: string; matTo: string; acct: string | null }
  const changes: Change[] = [];
  const contradictions: string[] = [];
  let identifiedTieBreaks = 0;

  for (const { t, leg } of rowOf.values()) {
    if (leg.movementForm === "CASH") continue;
    const forward = legs.filter((c) => legsQualify(leg, c));
    if (forward.length === 0) continue;

    const mk = (pool: TransferLeg[]): DestinationCandidate[] => pool.map((l) => ({
      legId: l.id, accountId: l.accountId, accountType: l.accountType,
      competingSourceCount: legs.filter((c) => legsQualify(l, c)).length,
      superseded: l.superseded,
    }));
    const union = (pool: TransferLeg[]) => {
      const s = new Set<string>([leg.id]);
      for (const l of pool) for (const c of legs) if (legsQualify(l, c)) s.add(c.id);
      return s.size;
    };

    const own = { accountType: leg.accountType, amount: t.amount, railType: leg.railType ?? null, venueClass: null, counterpartyClass: null };
    const before = resolveDestinationEvidence(mk(forward), { movementForm: leg.movementForm ?? null, competingSourceCount: union(forward) });

    // THE RUNG — via the authority's OWN helper, never a second copy of the
    // predicate. A duplicated rule is two rules, and this audit exists to police
    // the rule, not to restate it.
    const identified = narrowByIdentification(forward, leg.accountId);
    if (identified === forward || identified.length === forward.length) continue;
    identifiedTieBreaks++;

    const after = resolveDestinationEvidence(mk([...identified]), { movementForm: leg.movementForm ?? null, competingSourceCount: union([...identified]) });
    if (after.level === before.level && after.accountId === before.accountId) continue;

    changes.push({
      id: t.id, from: before.level, to: after.level,
      matFrom: maturityForEvidence(before, own), matTo: maturityForEvidence(after, own),
      acct: after.accountId,
    });

    // ⚠️ THE SAFETY CHECK. If a counterparty is already persisted and the rung
    // would name a DIFFERENT account, the rung is wrong — stop, do not ship.
    if (t.counterpartyAccountId && after.accountId && t.counterpartyAccountId !== after.accountId) {
      contradictions.push(
        `${t.id}: persisted ${A.get(t.counterpartyAccountId)?.name} but rung says ${A.get(after.accountId)?.name}`,
      );
    }
  }

  console.log(`  legs where the rung APPLIES (strict identified subset) : ${identifiedTieBreaks}`);
  console.log(`  legs whose LEVEL changes                              : ${changes.length}\n`);
  for (const c of changes) {
    const { t } = rowOf.get(c.id)!;
    const acct = A.get(t.financialAccountId ?? "");
    console.log(`  ${t.date.toISOString().slice(0, 10)} ${money(t.amount).padStart(12)} ${acct?.name}(${acct?.type})`);
    console.log(`      "${(t.merchant ?? "").slice(0, 54)}"`);
    console.log(`      ${c.from} → ${c.to}`);
    console.log(`      maturity ${c.matFrom} → ${c.matTo}   counterparty → ${c.acct ? A.get(c.acct)?.name : "none"}`);
  }

  bar("CONTRADICTIONS AGAINST PERSISTED COUNTERPARTIES");
  if (contradictions.length === 0) {
    console.log("  ✓ none — the rung never disagrees with an already-persisted counterparty");
  } else {
    console.log(`  ✗ ${contradictions.length}:`);
    for (const c of contradictions) console.log(`      ${c}`);
  }

  bar("VERDICT");
  console.log(contradictions.length === 0
    ? "  Safe to implement: the rung only narrows, and contradicts nothing already established."
    : "  ✗ DO NOT IMPLEMENT — the rung contradicts established counterparties.");
  console.log("\n[AUDIT] dry run complete — nothing was written.\n");
  if (contradictions.length > 0) process.exitCode = 1;
}

main()
  .catch((err) => { console.error("audit-transfer-identification failed:", err); process.exitCode = 1; })
  .finally(async () => { await db.$disconnect(); });
