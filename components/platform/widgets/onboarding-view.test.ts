/**
 * components/platform/widgets/onboarding-view.test.ts  (PB-7 Preview nits — pinned wording)
 *
 *   (a) a recovered import reads "Recovered after an interruption (earlier attempt: <reason>)",
 *       for every reason category — never "Recovered … — an unclassified failure";
 *   (b) "Recently joined" names a customer by the Customers list's display-identity rule
 *       (operatorDisplayName: username → name → opaque ref), never the raw email;
 *   (c) a customer with no bank but a wallet reads "no bank connection (wallet linked)".
 *
 * Run: npx tsx components/platform/widgets/onboarding-view.test.ts
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { IMPORT_REASON_LABELS, IMPORT_REASON_SHORT, recoveredPhrase, type ImportReasonCategory } from "@/lib/platform/onboarding/import-status-core";
import { operatorDisplayName } from "@/lib/platform/customer/identity-label";
import { buildRecentlyJoinedRows } from "@/lib/platform/customer/recently-joined-core";
import type { OnboardingConnection } from "@/lib/platform/customer/onboarding-core";
import { connectionImportDetail, connectionStatusWord, dotWord } from "./onboarding-view";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const strip = (rel: string) => readFileSync(path.join(process.cwd(), rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

console.log("(a) recovered wording");
check("UNKNOWN — exact", recoveredPhrase("UNKNOWN") === "Recovered after an interruption (earlier attempt: unclassified failure)", recoveredPhrase("UNKNOWN"));
check("INTERRUPTED — exact", recoveredPhrase("INTERRUPTED") === "Recovered after an interruption (earlier attempt: process ended mid-run)");
check("no reason — exact", recoveredPhrase(null) === "Recovered after an interruption");
for (const k of Object.keys(IMPORT_REASON_LABELS) as ImportReasonCategory[]) {
  const p = recoveredPhrase(k);
  check(`${k}: same pattern, short noun phrase (no article)`, p === `Recovered after an interruption (earlier attempt: ${IMPORT_REASON_SHORT[k]})` && !/^(a|an|the) /.test(IMPORT_REASON_SHORT[k]));
}
{
  const c: OnboardingConnection = {
    id: "i1", kind: "BANK", label: "Wells Fargo", linkedAt: "2026-11-01T20:44:00.000Z", importStatus: "recovered", interrupted: false,
    reason: "UNKNOWN", reasonLabel: IMPORT_REASON_LABELS.UNKNOWN, transactions: 1388, importCompletedAt: null, firstWealthRegenAt: null, attempts: 2, interruptedAttempts: 1,
  };
  check("the timeline row's status word carries the earlier attempt", connectionStatusWord(c) === "Recovered after an interruption (earlier attempt: unclassified failure)");
  const detail = connectionImportDetail(c);
  check("…and its detail no longer repeats the reason (no 'an unclassified failure' beside 'Recovered')", detail === "1,388 transactions · 2 attempts, 1 ended mid-run", detail);
  check("a failed row still states its reason", connectionImportDetail({ ...c, importStatus: "failed" }).startsWith("an unclassified failure"));
}

console.log("(b) display identity");
{
  check("username → name → opaque ref (the Customers list's rule)", operatorDisplayName({ id: "cuid_abc123", username: null, name: null }) === "user …abc123"
    && operatorDisplayName({ id: "x", username: "chris", name: "Chris H" }) === "chris");
  const panel = strip("components/platform/leads/CsRecentlyJoinedPanel.tsx");
  const list = strip("components/platform/widgets/CsCustomersWidget.tsx");
  check("the Customers list uses operatorDisplayName", /operatorDisplayName\(c\)/.test(list));
  check("Recently joined reuses it (imported from identity-label, not copied)", /from "@\/lib\/platform\/customer\/identity-label"/.test(panel) && /operatorDisplayName\(r\)/.test(panel) && !/function operatorDisplayName/.test(panel));
  check("…for the row name AND the open-profile label; the raw email is never rendered", (panel.match(/operatorDisplayName\(r\)/g) ?? []).length >= 2 && !/r\.email/.test(panel));
}

console.log("(c) wallet-only customers");
{
  check("none + wallet → 'no bank connection (wallet linked)'", dotWord("none", { wallets: 1 }) === "no bank connection (wallet linked)");
  check("none, nothing linked → 'no bank connection yet'", dotWord("none", { wallets: 0 }) === "no bank connection yet");
  check("a bank verdict is unaffected by wallets", dotWord("green", { wallets: 2 }) === "imports complete");
  const facts = { firstSession: new Map(), firstConnection: new Map(), firstAiTurn: new Map(), firstBriefView: new Map(), lastEngaged: new Map(),
    invitedEmails: new Set<string>(), walletCount: new Map([["u1", 1]]) };
  const rj = buildRecentlyJoinedRows({ windowDays: 14, total: 1, users: [{ id: "u1", email: "a@example.test", name: null, username: "a", createdAt: new Date("2026-10-30T00:00:00Z"), emailVerifiedAt: null }],
    facts, imports: [], floor: false });
  check("the row carries its wallet count, so the panel says 'wallet linked'", rj.rows[0].wallets === 1 && rj.rows[0].importHealth === "none"
    && dotWord(rj.rows[0].importHealth, rj.rows[0]) === "no bank connection (wallet linked)");
  check("the panel renders dotWord (not the static map)", /dotWord\(r\.importHealth, r\)/.test(strip("components/platform/leads/CsRecentlyJoinedPanel.tsx")));
}

if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nall checks passed");
