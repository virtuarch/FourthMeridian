/**
 * lib/alerts/latest-evaluation.test.ts  (UX-P1)
 *
 * "Firing now" is the LATEST evaluation's verdict and nothing else: the
 * delivery history never makes a rule active, an older run never outranks the
 * newest, the destination address never crosses into the projection, and a
 * never-run evaluator is null (unknown), not an empty "nothing firing".
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/alerts/latest-evaluation.test.ts
 */

import type { AlertRunSummary } from "@/lib/alerts/evaluate";
import { firingNow, latestAlertEvaluation, undeliveredSentence } from "./latest-evaluation";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

function run(over: Partial<AlertRunSummary> & { evaluatedAtISO: string }): AlertRunSummary {
  return {
    destination: "ops@example.test",
    deliveryStatus: "sent",
    counts: { evaluated: 5, live: 4, enabled: 4, firing: 0, delivered: 0, suppressed: 0 },
    rules: [],
    fired: [],
    ...over,
  };
}

const quietNow = run({
  evaluatedAtISO: "2026-10-14T06:30:00.000Z",
  rules: [
    { id: "job-failing", kind: "job-failing", enabled: true, live: true, firing: false, breaches: 0, severity: null },
    { id: "resource-stale", kind: "resource-stale", enabled: true, live: true, firing: false, breaches: 0, severity: null },
  ],
  // History: a critical delivered in THIS run's record from a prior cycle.
  fired: [{ ruleId: "job-failing", kind: "job-failing", dedupeKey: "job-failing:x", severity: "critical", summary: "x failed", deliveredAtISO: "2026-10-12T06:30:00.000Z" }],
});
const firingEarlier = run({
  evaluatedAtISO: "2026-10-14T00:30:00.000Z",
  rules: [{ id: "job-failing", kind: "job-failing", enabled: true, live: true, firing: true, breaches: 1, severity: "critical" }],
});

console.log("latest evaluation");
{
  check("no runs → null (unknown), never an empty verdict", latestAlertEvaluation([]) === null);
  const latest = latestAlertEvaluation([quietNow, firingEarlier]);
  check("the NEWEST run (first) wins", latest?.evaluatedAtISO === quietNow.evaluatedAtISO);
  check("nothing firing now even though history holds a critical", firingNow(latest).length === 0);
  check("an older firing run does not outrank the newest quiet one", !latest?.rules.some((r) => r.firing));
  check("the destination address is NOT in the projection", !("destination" in (latest as object)) && !JSON.stringify(latest).includes("ops@example.test"));
  const older = latestAlertEvaluation([firingEarlier]);
  check("a run with a breach reports it firing", firingNow(older).map((r) => r.id).join(",") === "job-failing");
  // A summary persisted before per-rule outcomes existed.
  const legacy = latestAlertEvaluation([{ ...quietNow, rules: undefined as unknown as AlertRunSummary["rules"] }]);
  check("a legacy summary without outcomes is still an evaluation, with no invented outcome", legacy !== null && legacy.rules.length === 0);
  // An unexpected key on a persisted outcome does not ride along.
  const polluted = latestAlertEvaluation([run({ evaluatedAtISO: "2026-10-14T07:00:00.000Z", rules: [{ ...quietNow.rules[0], ...({ email: "a@b.c" } as object) }] })]);
  check("outcomes are rebuilt field by field", !JSON.stringify(polluted).includes("a@b.c"));

  // OBS-003 — the undelivered outcome crosses into the projection, rebuilt.
  const lost = latestAlertEvaluation([run({ evaluatedAtISO: "2026-10-14T08:00:00.000Z", deliveryStatus: "skipped", undelivered: { reason: "NO_EMAIL_TRANSPORT", breaches: 3 } })]);
  check("undelivered is projected with reason and count", lost?.undelivered?.reason === "NO_EMAIL_TRANSPORT" && lost.undelivered.breaches === 3);
  check("the sentence names the cause and the count, no address", /3 breaches NOT delivered/.test(undeliveredSentence(lost!.undelivered!)) && /RESEND_API_KEY/.test(undeliveredSentence(lost!.undelivered!)) && !/@/.test(undeliveredSentence(lost!.undelivered!)));
  check("every reason has a sentence", (["NO_DESTINATION", "SEND_ERROR", "LEDGER_WRITE_FAILED"] as const).every((reason) => /NOT delivered/.test(undeliveredSentence({ reason, breaches: 1 }))));
  const legacyRow = latestAlertEvaluation([quietNow]);
  check("a legacy row without the field projects undelivered null", legacyRow?.undelivered === null);
  const bogus = latestAlertEvaluation([run({ evaluatedAtISO: "2026-10-14T08:00:00.000Z", undelivered: { reason: "SOMETHING_ELSE" as never, breaches: 1 } })]);
  check("an unknown reason on a persisted row is dropped, not passed through", bogus?.undelivered === null);

  // OBS-011 — destination presence, never the address; a legacy row's address becomes a boolean.
  check("legacy row with an address ⇒ destinationConfigured true, address absent", legacyRow?.destinationConfigured === true && !JSON.stringify(legacyRow).includes("ops@example.test"));
  const modern = latestAlertEvaluation([{ ...quietNow, destination: undefined, destinationConfigured: false }]);
  check("modern row ⇒ its boolean is projected as-is", modern?.destinationConfigured === false);
  const neither = latestAlertEvaluation([{ ...quietNow, destination: undefined }]);
  check("a row with neither field ⇒ null (not recorded), never a claim", neither?.destinationConfigured === null);
}

if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nall checks passed");
