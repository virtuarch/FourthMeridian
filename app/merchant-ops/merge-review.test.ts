/**
 * app/merchant-ops/merge-review.test.ts  (Merchant merge review — owner redesign 2026-10-31)
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs app/merchant-ops/merge-review.test.ts
 *
 * Pins the review page's exit path, purpose, decision gating and design language:
 *   1. a visible Back link to the Merchant Operations area (header AND empty state)
 *   2. write controls render only for a holder who can decide; read-only explains
 *   3. the reason is required before either verdict can be confirmed
 *   4. tier meanings / survivor rationale restate the detector, nothing invented
 *   5. the page's auth, TOTP redirect and systemDb reach are unchanged
 *   6. no raw palette classes in any review file
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { PendingMergeCandidate } from "@/lib/transactions/merchant-merge-review";
import { CandidateCard, EmptyReview, ReviewHeader, ReviewSummaryStrip } from "./ReviewChrome";
import { BACK_HREF, TIER_META, dialogCopy, outcomeLine, summarize, survivorRationale } from "./review-model";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`); }
}
const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");
const code = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");

const cand = (tier: "T1" | "T2", n: number): PendingMergeCandidate => ({
  survivorKey: `KEEP ${n}`, survivorId: `s${n}`, absorbedKey: `ABS ${n}`, absorbedId: `a${n}`,
  tier, signal: tier === "T1" ? "PLAID_ENTITY" : "CANONICAL_CONTAINMENT",
  explanation: `explanation ${n}`,
  survivor: { displayName: `Keep Co ${n}`, aliasCount: 3, transactionCount: 40, ruleCount: 1 },
  absorbed: { displayName: `Abs Co ${n}`, aliasCount: 1, transactionCount: 2, ruleCount: 0 },
});

console.log("1. exit path + purpose");
{
  check("Back goes to the Merchant Operations area", BACK_HREF === "/dashboard/platform/MERCHANT_OPS");
  const header = renderToStaticMarkup(createElement(ReviewHeader));
  check("header renders the Back link first, with its href", /^<header[^>]*><a[^>]*href="\/dashboard\/platform\/MERCHANT_OPS"/.test(header) && header.includes("Back to Merchant Operations"));
  check("Back link is a ≥44 px target below lg and never hidden at any width", /data-back-link[^>]*class="[^"]*min-h-11/.test(header) && !/(?:max-sm|sm|md|lg):hidden/.test(header));
  check("title + purpose of Merge and Not the same", header.includes("Merchant merge review") && /for every tenant/.test(header) && /not suggested again/.test(header) && /no undo button/.test(header));
  const empty = renderToStaticMarkup(createElement(EmptyReview));
  check("empty state names itself and carries the Back link", empty.includes("No pending merge candidates") && empty.includes(`href="${BACK_HREF}"`));
}

console.log("2. write controls only when canDecide");
{
  const list = code("app/merchant-ops/MergeReviewList.tsx");
  check("card actions are passed only when canDecide (hidden, not disabled)", /actions=\{canDecide \? \(/.test(list) && /\) : null\}/.test(list));
  check("no `disabled={… !canDecide …}` fallback on the verdict buttons", !/!canDecide/.test(list));
  const card = renderToStaticMarkup(createElement(CandidateCard, { candidate: cand("T1", 1) }));
  check("a card without actions renders no button", !/<button/.test(card));
  check("card shows tier meaning, explanation, Keep vs Absorb with counts",
    card.includes("The provider itself says these are one business.") && card.includes("explanation 1") && /Keep \(survives\)/.test(card) && /Absorb \(deleted after merge\)/.test(card)
      && card.includes("40 transactions") && card.includes("1 alias") && card.includes("0 rules"));
  const ro = renderToStaticMarkup(createElement(ReviewSummaryStrip, { summary: summarize([cand("T1", 1), cand("T2", 2), cand("T2", 3)]), canDecide: false }));
  check("read-only holders get the WRITE-grant explanation", /Read-only access/.test(ro) && /WRITE grant/.test(ro));
  const rw = renderToStaticMarkup(createElement(ReviewSummaryStrip, { summary: summarize([cand("T1", 1)]), canDecide: true }));
  check("decision holders are told a reason is required", /requires a reason and is audited/.test(rw) && !/Read-only/.test(rw));
  check("summary counts pending and by tier", /<span[^>]*>3<\/span><span[^>]*>pending candidates/.test(ro) && /data-tier-count="T2"><span[^>]*>2</.test(ro) && !/data-tier-count="T3"/.test(ro));
}

console.log("3. reason required before confirm");
{
  const list = code("app/merchant-ops/MergeReviewList.tsx");
  check("both verdicts open the ConfirmDialog (no direct POST from a card)", /onClick=\{\(\) => open\(c, "MERGED"\)\}/.test(list) && /onClick=\{\(\) => open\(c, "DISMISSED"\)\}/.test(list));
  check("the reason field lives in the dialog", /<ConfirmDialog[\s\S]*<OperatorReasonField[\s\S]*\/>/.test(list));
  check("confirm is disabled until a reason code is chosen", /confirmDisabled=\{chosen === null\}/.test(list) && /const chosen = reasonPayload\(reason\)/.test(list));
  check("decide() refuses without a reason, and sends it", /if \(!pending \|\| chosen === null\) return;/.test(list) && /reason: chosen/.test(list));
  check("the reason resets each time a dialog opens (never carried over)", /setPending\(\{ candidate, verdict \}\);\s*setReason\(EMPTY_OPERATOR_REASON\)/.test(list));
  check("errors render inside the dialog", /message=\{<>[\s\S]*\{error && <p role="alert"/.test(list));
  check("the decide request body is unchanged", /"\/api\/merchant-ops\/decide"/.test(list) && /verdict,\s*survivorKey: c\.survivorKey,\s*absorbedKey: c\.absorbedKey,\s*evidenceTier: c\.tier,\s*evidenceSignal: c\.signal,\s*reason: chosen/.test(list));
  const c = cand("T2", 7);
  check("outcome lines", outcomeLine("MERGED", c) === `Merged "Abs Co 7" into "Keep Co 7".` && /^Dismissed /.test(outcomeLine("DISMISSED", c)));
  check("dialogs state the outcome", /will be deleted/.test(dialogCopy("MERGED", c).outcome) && /No merchant is changed/.test(dialogCopy("DISMISSED", c).outcome));
}

console.log("4. copy restates the detector");
{
  const suggest = code("lib/transactions/merchant-merge-suggest.ts");
  check("T1 survivor = the merchant that owns the entity id", /return \{ survivor: b, absorbed: a \}/.test(suggest) && /own.*entity id/.test(survivorRationale("T1") ?? ""));
  check("T2 survivor = the longer key", /return \{ survivor: longM, absorbed: shortM \}/.test(suggest) && /longer/.test(survivorRationale("T2") ?? ""));
  check("T2 meaning matches the ≥2 shared leading tokens guard", /if \(shared < 2\) return null;/.test(suggest) && /at least two leading words/.test(TIER_META.T2.meaning));
  check("no rationale invented for the undetected T3", survivorRationale("T3") === null);
}

console.log("5. server page gating unchanged");
{
  const page = code("app/merchant-ops/page.tsx");
  check("READ gate, TOTP redirect, no-grant redirect, systemDb", page.includes('requirePlatformAccess("MERCHANT_OPS", "READ")')
    && /isOperatorTotpRefusal\(err\)\) redirect\(OPERATOR_TOTP_ENROLMENT_PATH\)/.test(page) && /if \(err\) redirect\("\/dashboard"\)/.test(page)
    && /import \{ systemDb as db \} from "@\/lib\/db"/.test(page));
  check("canDecide = WRITE or break-glass", /const canDecide = auth\.grant === null \|\| LEVEL_RANK\[auth\.grant\.level\] >= LEVEL_RANK\.WRITE;/.test(page));
}

console.log("6. no raw palette");
{
  // Built from parts so this file never contains a literal the ratchet would count.
  const raw = new RegExp(`\\b(?:bg|text|border)-(?:${["gr" + "ay", "red", "blue", "emerald", "green", "violet", "yellow", "amber", "purple"].join("|")})-\\d{2,3}\\b`);
  for (const f of ["app/merchant-ops/page.tsx", "app/merchant-ops/MergeReviewList.tsx", "app/merchant-ops/ReviewChrome.tsx"]) {
    check(`${f}: tokens only`, !raw.test(read(f)), read(f).match(raw)?.[0]);
  }
}

if (failures > 0) { console.error(`\n${failures} check(s) failed.`); process.exit(1); }
console.log("\nAll merchant merge review checks passed.");
