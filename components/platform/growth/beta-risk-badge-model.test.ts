/**
 * components/platform/growth/beta-risk-badge-model.test.ts
 *
 *     npx tsx --require ./scripts/lib/server-only-preload.cjs components/platform/growth/beta-risk-badge-model.test.ts
 */

import { BETA_RISK_LEVEL_LABEL, BETA_RISK_REASON_CODES, BETA_RISK_REASON_LABEL } from "@/lib/platform/growth/beta-risk-core";
import type { BetaRequestRisk } from "@/lib/platform/growth/beta-risk-types";
import { RISK_LEVEL_LABEL, evidenceWords, reviewLine, riskBadge, riskSignalLines } from "./beta-risk-badge-model";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`); }
}

const risk = (over: Partial<BetaRequestRisk>): BetaRequestRisk => ({ level: "review", reasons: [], review: null, ...over });

console.log("beta-risk badge model");

check("level labels mirror the core vocabulary exactly", JSON.stringify(RISK_LEVEL_LABEL) === JSON.stringify(BETA_RISK_LEVEL_LABEL));

check("no risk block ⇒ no badge", riskBadge(undefined) === null && riskBadge(null) === null);
check("level none ⇒ no badge", riskBadge(risk({ level: "none" })) === null);

const high = riskBadge(risk({ level: "high", reasons: [
  { code: "SHARED_NETWORK", label: BETA_RISK_REASON_LABEL.SHARED_NETWORK, evidence: { count: 4, windowMinutes: 1440 } },
  { code: "AUTOMATION_UA", label: BETA_RISK_REASON_LABEL.AUTOMATION_UA, evidence: { count: 2 } },
] }));
check("high ⇒ 'High suspicion', bad tone", high?.word === "High suspicion" && high.tone === "bad", high);
check("…title names the level, every signal and the advisory note",
  !!high && high.title.includes("Risk: High suspicion") && high.title.includes("Same network as other requesters")
  && high.title.includes("script or headless") && high.title.includes("Advisory only"), high?.title);
check("review ⇒ 'Review suggested', warn tone", riskBadge(risk({ level: "review" }))?.tone === "warn" && riskBadge(risk({ level: "review" }))?.word === "Review suggested");
check("insufficient ⇒ 'Insufficient evidence', muted tone", riskBadge(risk({ level: "insufficient" }))?.tone === "muted" && riskBadge(risk({ level: "insufficient" }))?.word === "Insufficient evidence");

check("evidence: burst in minutes", evidenceWords({ code: "BURST_WINDOW", evidence: { count: 6, windowMinutes: 10 } }) === "6 requests within 10 minutes");
check("evidence: shared network in hours", evidenceWords({ code: "SHARED_NETWORK", evidence: { count: 3, windowMinutes: 1440 } }) === "3 other requesters within 24 hours");
check("evidence: singular", evidenceWords({ code: "AUTOMATION_UA", evidence: { count: 1 } }) === "1 submission");
check("evidence: alias group / duplicate note", evidenceWords({ code: "ALIAS_CLUSTER", evidence: { count: 2 } }) === "2 addresses in the group"
  && evidenceWords({ code: "DUPLICATE_NOTE", evidence: { count: 3 } }) === "3 requests with this note");
check("evidence: none for a count-less reason (disposable domain)", evidenceWords({ code: "DISPOSABLE_DOMAIN", evidence: {} }) === null);
check("every reason code yields a string or null (never throws)",
  BETA_RISK_REASON_CODES.every((code) => { const w = evidenceWords({ code, evidence: { count: 2, windowMinutes: 10 } }); return w === null || typeof w === "string"; }));

const lines = riskSignalLines(risk({ reasons: [
  { code: "DISPOSABLE_DOMAIN", label: BETA_RISK_REASON_LABEL.DISPOSABLE_DOMAIN, evidence: {} },
  { code: "REPEATED_SUBMISSION", label: BETA_RISK_REASON_LABEL.REPEATED_SUBMISSION, evidence: { count: 3 } },
] }));
check("signal lines keep the server's order, label + evidence",
  lines.length === 2 && lines[0].text === "Disposable email domain" && lines[0].evidence === null
  && lines[1].text === "Submitted several times" && lines[1].evidence === "3 submissions", lines);
check("no risk ⇒ no lines", riskSignalLines(undefined).length === 0);

check("review line: none / unreviewed ⇒ null", reviewLine(risk({})) === null
  && reviewLine(risk({ review: { status: "UNREVIEWED", at: "2026-11-01T00:00:00Z", by: "op" } })) === null);
check("review line: verdict + operator", reviewLine(risk({ review: { status: "LEGITIMATE", at: "2026-11-01T00:00:00Z", by: "alice" } })) === "Marked legitimate by alice"
  && reviewLine(risk({ review: { status: "SUSPICIOUS", at: "2026-11-01T00:00:00Z", by: null } })) === "Marked suspicious");
check("a recorded verdict appears in the badge title", riskBadge(risk({ level: "high", review: { status: "LEGITIMATE", at: "2026-11-01T00:00:00Z", by: "alice" } }))?.title.includes("Marked legitimate by alice") === true);
check("neutral vocabulary — never 'bot', 'fraud' or 'malicious'",
  !/\b(bot|fraud|malicious)\b/i.test(JSON.stringify([RISK_LEVEL_LABEL, high, lines])));

console.log(failures === 0 ? "\nAll beta-risk badge model checks passed." : `\n${failures} failure(s).`);
process.exit(failures === 0 ? 0 : 1);
