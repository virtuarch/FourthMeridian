/**
 * lib/platform/intelligence/ai/memory/memory.test.ts  (Platform AI operational memory — PR-A unit + schema tests)
 *
 * Design v2 §8 (unit, schema). No database, no network:
 *   1. the B2 registries in ./constants.ts = the LIVE sources (metric registry,
 *      navigation registry, retrieval parts, metric windows, scheduled jobs,
 *      PROVIDER_SPECS) — so a new key cannot be referenced without a migration;
 *   2. schema tests: the table has no column referencing a conversation; D6 —
 *      PlatformGrant has status ∈ {ACTIVE, REVOKED} and NO expiry / suspension
 *      column (fails if one is added, so the RLS grant term changes with it);
 *   3. the payload allowlist per fact type and validateSourceRefs (the trigger's
 *      mirror), including ref-id smuggling;
 *   4. every note-guard reason, the B6 amount cases and their negatives, D7;
 *   5. the observed-state maps (never a number);
 *   6. the purge orchestration (disabled = no contact, misordered, batches, audit, failure);
 *   7. source pins: the store never imports systemDb, never writes a timestamp or
 *      deletedAt, soft-deletes only through the definer; the flags and the wiring.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/platform/intelligence/ai/memory/memory.test.ts
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { METRICS, metricKey } from "@/lib/platform/intelligence/metrics/registry";
import { NAVIGATION_TARGETS } from "@/lib/platform/intelligence/navigation/registry";
import { RETRIEVAL } from "@/lib/platform/intelligence/metrics/retrieve-core";
import { SCHEDULED_JOB_FACTS } from "@/lib/jobs/registry.core";
import { PROVIDER_SPECS } from "@/lib/platform/provider-health";
import {
  MEMORY_FACT_TYPES, MEMORY_JOB_NAMES, MEMORY_METRIC_KEYS, MEMORY_METRIC_PARTS, MEMORY_METRIC_WINDOWS, MEMORY_OBSERVED_STATES,
  MEMORY_PAGE_IDS, MEMORY_PROVIDER_IDS, MEMORY_PURGE_BATCH, MEMORY_PURGE_MAX_CALLS, MEMORY_REF_ID_MAX, MEMORY_TTL_CHOICES,
} from "./constants";
import { incidentObservedState, jobObservedState, metricObservedState, payloadProblem, providerObservedState, refProblem, sourceRefsProblem, validateSourceRefs } from "./schema";
import { AMOUNT_SHAPES, clipNote, hasVerbatimSpan, validateOperatorNote, wordShingles } from "./note-guard";
import { parseMemoryPurgeRow, platformAiMemoryPurgeJobFailure, runPlatformAiMemoryPurge, type PlatformAiMemoryPurgeDeps } from "./purge";

let failures = 0;
function check(name: string, ok: boolean, detail: unknown = ""): void {
  if (ok) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail === "" ? "" : ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`); }
}
const ROOT = process.cwd();
const read = (f: string) => readFileSync(path.join(ROOT, f), "utf8");
const sorted = (xs: readonly (string | number)[]) => JSON.stringify([...xs].map(String).sort());

async function main(): Promise<void> {
  console.log("1. B2 registries = the live sources");
  {
    check("MEMORY_METRIC_KEYS = METRICS.map(metricKey)", sorted(MEMORY_METRIC_KEYS) === sorted(METRICS.map(metricKey)));
    check("MEMORY_PAGE_IDS = NAVIGATION_TARGETS ids", sorted(MEMORY_PAGE_IDS) === sorted(NAVIGATION_TARGETS.map((t) => t.id)));
    const parts = new Set<string>();
    for (const c of Object.values(RETRIEVAL as Record<string, { valueUnits?: unknown }>)) {
      if (c && typeof c.valueUnits === "object" && c.valueUnits !== null) for (const k of Object.keys(c.valueUnits)) parts.add(k);
    }
    check("MEMORY_METRIC_PARTS = every retrieval contract's valueUnits part", sorted(MEMORY_METRIC_PARTS) === sorted([...parts]));
    check("MEMORY_METRIC_WINDOWS = the union of every metric's window.days", sorted(MEMORY_METRIC_WINDOWS) === sorted([...new Set(METRICS.flatMap((m) => m.window.days ?? []))]));
    check("MEMORY_JOB_NAMES = SCHEDULED_JOB_FACTS names", sorted(MEMORY_JOB_NAMES) === sorted(SCHEDULED_JOB_FACTS.map((j) => j.name)));
    check("MEMORY_PROVIDER_IDS = PROVIDER_SPECS keys (the provider pages' identity)", sorted(MEMORY_PROVIDER_IDS) === sorted(PROVIDER_SPECS.map((p) => p.key)));
    const all = [...MEMORY_METRIC_KEYS, ...MEMORY_PAGE_IDS, ...MEMORY_JOB_NAMES, ...MEMORY_PROVIDER_IDS];
    check(`every registered id fits the ${MEMORY_REF_ID_MAX}-character ref id bound`, all.every((x) => x.length <= MEMORY_REF_ID_MAX), all.filter((x) => x.length > MEMORY_REF_ID_MAX));
    check("TTL choices (D8): OPERATIONAL_STATE fixed 72 h; others 7 d or 30 d",
      JSON.stringify(MEMORY_TTL_CHOICES) === JSON.stringify({ OPERATIONAL_STATE: ["H72"], WATCHING_ISSUE: ["D7", "D30"], FOLLOW_UP: ["D7", "D30"], OPERATOR_PREFERENCE: ["D7", "D30"] }));
  }

  console.log("2. schema tests (design §8; D6)");
  {
    const schema = read("prisma/schema.prisma");
    const block = (name: string) => new RegExp(`^model ${name} \\{([\\s\\S]*?)^\\}`, "m").exec(schema)?.[1] ?? "";
    const fact = block("PlatformAiMemoryFact");
    const cols = [...fact.matchAll(/^\s{2}(\w+)\s+\w/gm)].map((m) => m[1]);
    check("PlatformAiMemoryFact exists with the design's columns",
      sorted(cols) === sorted(["id", "operatorUserId", "operator", "platformArea", "factType", "origin", "concern", "noteEncrypted", "payload", "sourceRefs", "ttl", "proposalJti", "observedAt", "createdAt", "expiresAt", "invalidatedAt", "invalidReason", "deletedAt", "supersedesId"]), cols);
    check("no column or relation references a conversation, message, transcript or AiInvocation",
      !/conversation|message|transcript|invocation/i.test(fact.replace(/^\s*\/\/\/.*$/gm, "")));
    const grant = block("PlatformGrant");
    const gcols = [...grant.matchAll(/^\s{2}(\w+)\s+\w/gm)].map((m) => m[1]);
    check("D6: PlatformGrant's columns are exactly the known set — no expiry / suspension column (add one ⇒ change the memory RLS grant term with it)",
      sorted(gcols) === sorted(["id", "userId", "user", "area", "level", "status", "grantedById", "grantedBy", "grantedAt", "revokedAt", "revokedById", "revokedBy", "updatedAt"])
        && !/expir|suspend|until|validTo/i.test(grant), gcols);
    const status = /^enum PlatformGrantStatus \{([\s\S]*?)^\}/m.exec(schema)?.[1].split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("//")) ?? [];
    check("D6: PlatformGrantStatus = {ACTIVE, REVOKED} (the policy's status = 'ACTIVE' is then a complete check)", sorted(status) === sorted(["ACTIVE", "REVOKED"]), status);
  }

  console.log("3. payloads and sourceRefs (the trigger's mirror)");
  {
    check("payload: WATCHING_ISSUE {} ok; any key refused", payloadProblem("WATCHING_ISSUE", {}) === null && payloadProblem("WATCHING_ISSUE", { expected: "OPEN" }) !== null);
    check("payload: OPERATIONAL_STATE expected ∈ OPEN|DEGRADED|FAILING", payloadProblem("OPERATIONAL_STATE", { expected: "DEGRADED" }) === null && payloadProblem("OPERATIONAL_STATE", { expected: "BROKEN" }) !== null);
    check("payload: FOLLOW_UP due ∈ H24|D7; a number is refused", payloadProblem("FOLLOW_UP", { due: "D7" }) === null && payloadProblem("FOLLOW_UP", { due: 7 }) !== null);
    check("payload: OPERATOR_PREFERENCE needs pref", payloadProblem("OPERATOR_PREFERENCE", {}) !== null && payloadProblem("OPERATOR_PREFERENCE", { pref: "TERSE_ANSWERS" }) === null);
    check("payload: a conversation / message / transcript key is refused", ["conversationId", "messageText", "transcript"].every((k) => payloadProblem("WATCHING_ISSUE", { [k]: "x" }) !== null));
    check("payload: not an object ⇒ refused", payloadProblem("WATCHING_ISSUE", []) !== null && payloadProblem("WATCHING_ISSUE", "x") !== null);
    const ok = { t: "METRIC", id: "provider-outcome@1", part: "failing", w: 7, observedState: "DEGRADED" };
    check("ref: a registered METRIC with part, window and state is accepted", refProblem(ok) === null);
    check("ref: INCIDENT cuid / PAGE / JOB / PROVIDER registered ids are accepted",
      [{ t: "INCIDENT", id: "c" + "a".repeat(24), observedState: "OPEN" }, { t: "PAGE", id: "PLATFORM_OPS:platform-incidents:open", observedState: "OK" },
        { t: "JOB", id: "sync-banks", observedState: "FAILED" }, { t: "PROVIDER", id: "PLAID", observedState: "DEGRADED" }].every((r) => refProblem(r) === null));
    const bad: Array<[string, unknown]> = [
      ["an extra key", { ...ok, note: "x" }],
      ["an id over 64 characters", { t: "METRIC", id: "x".repeat(65), observedState: "OK" }],
      ["an unregistered metric", { t: "METRIC", id: "provider-outcome@9", observedState: "OK" }],
      ["an unregistered page", { t: "PAGE", id: "PLATFORM_OPS:secret", observedState: "OK" }],
      ["a numeric observedState", { t: "METRIC", id: "provider-outcome@1", observedState: 3 }],
      ["an observedState outside the list", { t: "METRIC", id: "provider-outcome@1", observedState: "BROKEN" }],
      ["an unknown part", { t: "METRIC", id: "provider-outcome@1", part: "secretPart", observedState: "OK" }],
      ["an unknown window", { t: "METRIC", id: "provider-outcome@1", w: 14, observedState: "OK" }],
      ["a window as a string", { t: "METRIC", id: "provider-outcome@1", w: "7", observedState: "OK" }],
      ["part on a non-METRIC ref", { t: "JOB", id: "sync-banks", part: "failing", observedState: "OK" }],
      ["an unknown ref type", { t: "USER", id: "u1", observedState: "OK" }],
      ["a missing id", { t: "METRIC", observedState: "OK" }],
      ["REF-ID SMUGGLING: transcript text as an INCIDENT id", { t: "INCIDENT", id: "the customer said their card ends", observedState: "OPEN" }],
      ["REF-ID SMUGGLING: transcript text as a METRIC id", { t: "METRIC", id: "jane at example dot com owes", observedState: "OK" }],
      ["REF-ID SMUGGLING: a cuid with trailing text", { t: "INCIDENT", id: "c" + "a".repeat(24) + " note", observedState: "OPEN" }],
      ["REF-ID SMUGGLING: an email as a PROVIDER id", { t: "PROVIDER", id: "jane@example.com", observedState: "OK" }],
    ];
    for (const [what, r] of bad) check(`ref refused: ${what}`, refProblem(r) !== null);
    check("refs: at least one for non-PREFERENCE, none required for PREFERENCE, at most 5",
      sourceRefsProblem("WATCHING_ISSUE", []) !== null && sourceRefsProblem("OPERATOR_PREFERENCE", []) === null && sourceRefsProblem("WATCHING_ISSUE", Array(6).fill(ok)) !== null);
    const v = validateSourceRefs("WATCHING_ISSUE", [ok]);
    check("validateSourceRefs returns a copy with the allowed keys only", !!v && JSON.stringify(v[0]) === JSON.stringify(ok));
  }

  console.log("4. the note guard (B6, D7)");
  {
    const reason = (n: string, ctx = {}) => { const v = validateOperatorNote(n, ctx); return v.ok ? "OK" : v.reason; };
    check("an empty / whitespace note is no note (null)", (() => { const v = validateOperatorNote("   "); return v.ok && v.note === null; })());
    check("a plain operator note passes", reason("webhook retries look stuck, check after deploy") === "OK");
    check("the note is clipped to 140 characters", (clipNote("a ".repeat(200)) ?? "").length <= 140);
    for (const n of ["$5", "5k", "2 bn", "1,200", "3.5", "40%", "12 pct", "€3", "4 £", "7M spend", "20 percent"]) check(`B6 amount refused: "${n}"`, reason(`cost was ${n} today`) === "NOTE_AMOUNT", reason(`cost was ${n} today`));
    for (const n of ["v2", "step 3", "retry 2 times", "3 providers", "week 2"]) check(`B6 negative passes: "${n}"`, reason(`check ${n} later`) === "OK", reason(`check ${n} later`));
    check("an email ⇒ NOTE_LINK (the @)", reason("ask jane@example.com") === "NOTE_LINK");
    check("a URL / braces ⇒ NOTE_LINK", reason("see https://x.test/a") === "NOTE_LINK" && reason("see {{m:x}}") === "NOTE_LINK" && reason("see status.io") === "NOTE_LINK");
    check("a cuid / user reference ⇒ NOTE_IDENTITY", reason(`incident c${"a".repeat(24)}`) === "NOTE_IDENTITY" && reason("user #3fa9c21b again") === "NOTE_IDENTITY");
    check("a 4+ digit run / card shape ⇒ NOTE_IDENTIFIER", reason("ref 12345") === "NOTE_IDENTIFIER" && reason("card 4111 1111 1111 1111") === "NOTE_IDENTIFIER" && reason("October 2026 review") === "NOTE_IDENTIFIER");
    check("over 200 UTF-8 bytes ⇒ NOTE_TOO_LONG", reason("☃".repeat(100)) === "NOTE_TOO_LONG");
    const q = "Why are the plaid webhook retries piling up for the sync banks job this morning";
    check("D7 (propose): a 6-word span of the question ⇒ NOTE_VERBATIM", reason("note: plaid webhook retries piling up for the sync", { verbatimSources: [q] }) === "NOTE_VERBATIM");
    check("D7 (propose): a 40-character span (fewer than 6 words) ⇒ NOTE_VERBATIM",
      hasVerbatimSpan("xx supercalifragilisticexpialidociousness overwhelming", ["supercalifragilisticexpialidociousness overwhelming yes"]));
    check("D7: 5 shared words is not a span", reason("plaid webhook retries piling up today", { verbatimSources: [q] }) === "OK");
    check("D7 is propose-time only: the Remember button (no sources) does not run it", reason("plaid webhook retries piling up for the sync") === "OK");
    check("shingles are 6-word windows of normalised text", JSON.stringify(wordShingles("A, b. C d e F g")) === JSON.stringify(["a b c d e f", "b c d e f g"]));
    check("the amount shapes are the four B6 rules", AMOUNT_SHAPES.length === 4);
  }

  console.log("5. observed-state maps (closed list, never a number)");
  {
    const all = [
      metricObservedState({ status: "UNAVAILABLE" }), metricObservedState({ status: "MEASURED", subjects: [{ state: "failing" }] }),
      metricObservedState({ status: "MEASURED", subjects: [{ state: "stale" }] }), metricObservedState({ status: "PARTIAL", subjects: [] }),
      incidentObservedState("active"), incidentObservedState("acknowledged"), incidentObservedState("resolved"), incidentObservedState("archived"), incidentObservedState("weird"),
      jobObservedState("running"), jobObservedState("succeeded"), jobObservedState("failed"), jobObservedState(null),
      providerObservedState("OPERATIONAL"), providerObservedState("DEGRADED"), providerObservedState("STALE"), providerObservedState("FAILING"), providerObservedState("INSUFFICIENT_DATA"),
    ];
    check("every map yields a member of MEMORY_OBSERVED_STATES", all.every((s) => (MEMORY_OBSERVED_STATES as readonly string[]).includes(s)), all);
    check("metric: UNAVAILABLE ⇒ UNKNOWN; failing subject ⇒ FAILING; other subject ⇒ DEGRADED; none ⇒ OK", JSON.stringify(all.slice(0, 4)) === JSON.stringify(["UNKNOWN", "FAILING", "DEGRADED", "OK"]));
    check("incident: active ⇒ OPEN, acknowledged ⇒ ACKNOWLEDGED, resolved / archived ⇒ RESOLVED", JSON.stringify(all.slice(4, 9)) === JSON.stringify(["OPEN", "ACKNOWLEDGED", "RESOLVED", "RESOLVED", "UNKNOWN"]));
    check("provider trust: OPERATIONAL ⇒ OK, DEGRADED / STALE ⇒ DEGRADED, FAILING ⇒ FAILING, else UNKNOWN", JSON.stringify(all.slice(13)) === JSON.stringify(["OK", "DEGRADED", "DEGRADED", "FAILING", "UNKNOWN"]), all.slice(13));
    check("fact types are the four of the design", MEMORY_FACT_TYPES.length === 4);
  }

  console.log("6. the purge orchestration");
  {
    const quiet = async <T,>(f: () => Promise<T>): Promise<T> => { const o = { log: console.log, error: console.error }; console.log = () => {}; console.error = () => {}; try { return await f(); } finally { Object.assign(console, o); } };
    const seam = (enabled: boolean, results: Array<number | Error>, extra: Partial<PlatformAiMemoryPurgeDeps> = {}) => {
      const calls: number[] = []; const audits: unknown[] = [];
      const deps: PlatformAiMemoryPurgeDeps = {
        enabled, ...extra,
        call: async (l) => { calls.push(l); const r = results.shift() ?? 0; if (r instanceof Error) throw r; return r; },
        audit: async (d) => { audits.push(d); },
      };
      return { deps, calls, audits };
    };
    const off = seam(false, [9]);
    const rOff = await quiet(() => runPlatformAiMemoryPurge(off.deps));
    check("DISABLED: no call, no audit, enabled:false", off.calls.length === 0 && off.audits.length === 0 && rOff.enabled === false && rOff.misordered === undefined);
    const mis = seam(false, [9], { misordered: true });
    const rMis = await quiet(() => runPlatformAiMemoryPurge(mis.deps));
    check("MISORDERED (memory flag set, purge off): no contact, misordered ⇒ a fixed JobRun failure", mis.calls.length === 0 && rMis.misordered === true && /^platform-ai-memory purge MISORDERED:/.test(platformAiMemoryPurgeJobFailure(rMis) ?? ""));
    const on = seam(true, [MEMORY_PURGE_BATCH, 3]);
    const rOn = await quiet(() => runPlatformAiMemoryPurge(on.deps));
    check("ENABLED: batches until a short batch; counts summed; one counts-only audit row",
      JSON.stringify(on.calls) === JSON.stringify([MEMORY_PURGE_BATCH, MEMORY_PURGE_BATCH]) && rOn.facts === MEMORY_PURGE_BATCH + 3 && rOn.exhausted && JSON.stringify(on.audits) === JSON.stringify([{ facts: MEMORY_PURGE_BATCH + 3, batches: 2, exhausted: true }]));
    const sat = seam(true, Array(MEMORY_PURGE_MAX_CALLS + 2).fill(MEMORY_PURGE_BATCH));
    const rSat = await quiet(() => runPlatformAiMemoryPurge(sat.deps));
    check(`bounded: at most ${MEMORY_PURGE_MAX_CALLS} calls per run, then "more remain"`, sat.calls.length === MEMORY_PURGE_MAX_CALLS && !rSat.exhausted);
    const zero = seam(true, [0]);
    await quiet(() => runPlatformAiMemoryPurge(zero.deps));
    const zeroManual = seam(true, [0], { auditEveryRun: true });
    await quiet(() => runPlatformAiMemoryPurge(zeroManual.deps));
    check("nothing removed: no audit row (scheduled); the manual dispatch audits every run", zero.audits.length === 0 && zeroManual.audits.length === 1);
    const fail = seam(true, [new Error("boom secret")]);
    const rFail = await quiet(() => runPlatformAiMemoryPurge(fail.deps));
    check("a failing call: error reported, a FAILED JobRun message that never echoes the error",
      rFail.error === "boom secret" && /^platform-ai-memory purge FAILED/.test(platformAiMemoryPurgeJobFailure(rFail) ?? "") && !(platformAiMemoryPurgeJobFailure(rFail) ?? "").includes("secret"));
    check("parseMemoryPurgeRow: one {facts} row only", parseMemoryPurgeRow([{ facts: 4 }]) === 4 && parseMemoryPurgeRow([{ facts: BigInt(2) }]) === 2
      && [[], [{ facts: -1 }], [{ facts: 1, id: "x" }], [{ n: 1 }]].every((r) => { try { parseMemoryPurgeRow(r); return false; } catch { return true; } }));
  }

  console.log("7. source pins: the store, the wiring, the flags");
  {
    const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
    const store = strip(read("lib/platform/intelligence/ai/memory/store.ts"));
    check("store.ts never imports systemDb (no fm_system path)", !/systemDb/.test(store));
    check("store.ts runs every statement through withTenantDb", /from "@\/lib\/db\/tenant-context"/.test(store) && !/from "@\/lib\/db"/.test(store));
    check("store.ts never names createdAt / observedAt / expiresAt / invalidatedAt / deletedAt in a write",
      !/(createdAt|observedAt|expiresAt|invalidatedAt|deletedAt)\s*:\s*(new Date|now\()/.test(store) && !/data: \{[^}]*\b(createdAt|observedAt|expiresAt|invalidatedAt|deletedAt)\b/.test(store));
    check("O1 (b): the soft delete is ONLY the definer function", /SELECT public\.fm_platform_ai_memory_soft_delete\(\$1::text\) AS n/.test(store) && !/deletedAt: new Date|"deletedAt"\s*=/.test(store));
    check("D8: the visibility helper filters invalidatedAt IS NULL (and the owner)", /export const VISIBLE = \(operatorId: string\) => \(\{ operatorUserId: operatorId, deletedAt: null, invalidatedAt: null \}\)/.test(store));
    check("the note's ONE encrypt site uses PLATFORM_AI_MEMORY", (store.match(/encryptWithPurpose\(/g) ?? []).length === 1 && /encryptWithPurpose\(input\.note, EncryptionPurpose\.PLATFORM_AI_MEMORY\)/.test(store));
    check("audit detail never carries a note, payload or ref id", [...store.matchAll(/detail: \{([^}]*)\}/g)].every((m) => !/\b(note|payload|refs|sourceRefs|noteEncrypted)\s*[:,}]/.test(m[1] + "}")));
    const dr = strip(read("jobs/data-retention.ts"));
    check("data-retention runs the memory purge after the conversations purge, never in a dry run",
      /const memoryDeps = opts\.platformAiMemoryPurge \?\? \(client \? null : await platformAiMemoryPurgeDeps\("SCHEDULED"\)\);\s*if \(memoryDeps && !dryRun\) out\.platformAiMemory = await runPlatformAiMemoryPurge\(memoryDeps\);/.test(dr));
    check("the memory purge seam: env.isPlatformAiMemoryPurgeEnabled (manual dispatch always on), fm_system via systemDb",
      /enabled: manual \? true : env\.isPlatformAiMemoryPurgeEnabled/.test(dr) && /PLATFORM_AI_MEMORY_PURGE_SQL, limit/.test(dr));
    check("purge-trash fails its JobRun on a failed / misordered memory purge", /platformAiMemoryPurgeJobFailure\(retention\.platformAiMemory\)/.test(read("jobs/purge-trash.ts")));
    const env = read("lib/env.ts");
    check("isPlatformAiMemoryEnabled = Platform AI + conversations + conversation purge + memory purge + memory flag (all strict \"true\")",
      /get isPlatformAiMemoryEnabled\(\) \{ return _e\.PLATFORM_AI_ENABLED === "true" && _e\.PLATFORM_AI_CONVERSATIONS_ENABLED === "true" && _e\.PLATFORM_AI_PURGE_ENABLED === "true" && _e\.PLATFORM_AI_MEMORY_PURGE_ENABLED === "true" && _e\.PLATFORM_AI_MEMORY_ENABLED === "true"; \}/.test(env));
    check("isPlatformAiMemoryPurgeEnabled = the memory purge flag alone (keeps running after memory is off)", /get isPlatformAiMemoryPurgeEnabled\(\) \{ return _e\.PLATFORM_AI_MEMORY_PURGE_ENABLED === "true"; \}/.test(env));
    const { env: live } = await import("@/lib/env");
    check("in this process (no memory flag set) memory is OFF", live.isPlatformAiMemoryEnabled === false && live.isPlatformAiMemoryPurgeEnabled === false);
  }

  if (failures > 0) { console.error(`\n${failures} check(s) FAILED`); process.exit(1); }
  console.log("\nAll Platform AI memory (PR-A) checks passed.");
}

main().catch((e) => { console.error(e); process.exit(1); });
