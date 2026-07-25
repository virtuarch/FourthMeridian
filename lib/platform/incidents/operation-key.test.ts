/**
 * lib/platform/incidents/operation-key.test.ts  (OPS-2D-5B-0)
 *
 * The identity contract, locked before the taxonomy is built on top of it.
 *
 * OPS-2D-5B will change the PUBLIC issue codes that describe these failures.
 * The whole risk of that slice is that renaming a description silently moves an
 * incident's identity — orphaning every active episode and opening duplicates
 * beside them, with nothing failing and nothing warning. So the contract is
 * settled and proven first:
 *
 *   identity follows the OPERATION
 *   not the issue kind, not the wording, not the file it was raised in
 *
 * Run:  npx tsx lib/platform/incidents/operation-key.test.ts
 */

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { buildIncidentKey } from "./identity";
import {
  resolveOperationKey, isRegisteredOperation,
  OPERATION_KEYS, OPERATION_KEY_ALIASES, UNREGISTERED_PREFIX,
} from "./operation-key";
import { classifySyncIssue } from "@/lib/platform/sync-issue-semantics";
import { recordIncidentObservation } from "./lifecycle";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const ROOT = process.cwd();
const code = (rel: string) =>
  readFileSync(path.join(ROOT, rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
function walk(dir: string, out: string[] = []): string[] {
  let e; try { e = readdirSync(path.join(ROOT, dir), { withFileTypes: true }); } catch { return out; }
  for (const x of e) {
    if (x.name === "node_modules" || x.name === ".next" || x.name === "prototype") continue;
    const rel = path.join(dir, x.name);
    if (x.isDirectory()) walk(rel, out); else if (/\.tsx?$/.test(x.name)) out.push(rel);
  }
  return out;
}

/** Identity for a failure, varying only what the test is probing. */
const key = (o: { stage?: string | null; scope?: string; kind?: string }) => (
  // `kind` is accepted and deliberately IGNORED — that is the assertion.
  void o.kind,
  buildIncidentKey({
    provider: "PLAID",
    plaidItemId: o.scope ?? "item1",
    domain: "transactions",
    stage: resolveOperationKey(o.stage ?? "transaction-persist"),
  }));

async function main() {
  // ── 1. Identity follows the OPERATION, not the public code ──────────────────
  //
  // The load-bearing assertion of the whole slice. A taxonomy deployment must
  // read as "the same problem, better described" — never as recovery, never as
  // supersession, never as a new episode.
  console.log("1. the issue kind is absent from identity");
  {
    // Same operation, two different public kinds — one identity.
    const asGeneric  = key({ kind: "UPSERT_ERROR" });
    const asSpecific = key({ kind: "TRANSACTION_PERSISTENCE_FAILED" });
    check("old generic kind and new specific kind produce the SAME identity",
      asGeneric === asSpecific, `${asGeneric} vs ${asSpecific}`);
    check("no issue kind appears in the key at all",
      !/UPSERT_ERROR|TRANSACTION_PERSISTENCE|MISSING_ACCOUNT/.test(asGeneric), asGeneric);

    // …and the identity builder has no parameter through which a kind could leak.
    const src = code("lib/platform/incidents/identity.ts");
    check("IncidentIdentityInput exposes no issue-kind field",
      !/\bkind\s*[?:]/.test(src.slice(src.indexOf("interface IncidentIdentityInput"), src.indexOf("}", src.indexOf("interface IncidentIdentityInput")))));
  }

  // ── 2. Different operations stay different ──────────────────────────────────
  console.log("2. one public kind never merges distinct operations");
  {
    check("two operations under one kind remain distinct episodes",
      key({ stage: "opening-position-repair" }) !== key({ stage: "investment-import-repair" }));
    check("wallet operations remain distinct",
      new Set(["discovery", "balance", "price"].map((s) => key({ stage: s }))).size === 3);
    // Scope still separates, unchanged from 5A-2.
    check("the same operation on a different scope stays separate",
      key({ scope: "itemA" }) !== key({ scope: "itemB" }));
  }

  // ── 3. Wording is not identity ──────────────────────────────────────────────
  console.log("3. a rename goes through the alias table, not the key");
  {
    // Simulating the alias contract without mutating the shipped registry.
    const aliased: Record<string, string> = { ...OPERATION_KEY_ALIASES, "transaction-write": "transaction-persist" };
    const resolveWith = (stage: string) =>
      stage in OPERATION_KEYS ? OPERATION_KEYS[stage as keyof typeof OPERATION_KEYS]
      : aliased[stage] ?? `${UNREGISTERED_PREFIX}${stage}`;
    check("an aliased new spelling resolves to the ORIGINAL key",
      resolveWith("transaction-write") === "transaction-persist");
    check("…so the incident identity is unchanged by the rename",
      buildIncidentKey({ provider: "PLAID", plaidItemId: "item1", domain: "transactions",
                         stage: resolveWith("transaction-write") }) === key({}));
    check("the alias table exists and starts empty (a rename has a home)",
      Object.keys(OPERATION_KEY_ALIASES).length === 0);
  }

  // ── 4. Producers cannot invent identity ─────────────────────────────────────
  console.log("4. only registered operations get registered keys");
  {
    check("a registered stage is recognised", isRegisteredOperation("transaction-persist"));
    check("an invented stage is NOT registered", !isRegisteredOperation("whatever-i-typed"));
    check("an invented stage is namespaced, not accepted",
      resolveOperationKey("whatever-i-typed") === `${UNREGISTERED_PREFIX}whatever-i-typed`);
    // The critical half: unknown stages must not COLLAPSE into one global episode.
    check("two different unknown stages stay different",
      resolveOperationKey("mystery-a") !== resolveOperationKey("mystery-b"));
    check("an absent stage resolves to null, not a sentinel string",
      resolveOperationKey(null) === null && resolveOperationKey("  ") === null);

    // Every stage a production producer actually writes must be registered, or
    // the registry is decorative.
    const stages = new Set<string>();
    for (const f of [...walk("lib"), ...walk("app")].filter((x) => !/\.test\.tsx?$/.test(x))) {
      for (const m of code(f).matchAll(/stage:\s*"([a-z][a-z-]*)"/g)) stages.add(m[1]);
    }
    const unregistered = [...stages].filter((s) => !isRegisteredOperation(s));
    // "load" is btc-sync's own result-shape field and never reaches SyncIssue.
    const realUnregistered = unregistered.filter((s) => s !== "load" && s !== "unit-test" && s !== "s");
    check(`every production incident stage is registered (${stages.size} found)`,
      realUnregistered.length === 0, realUnregistered.join(", "));
  }

  // ── 5. Legacy identity is preserved byte-for-byte ───────────────────────────
  console.log("5. routing identity through the registry moved nothing");
  {
    check("a Plaid transaction key is byte-identical to 5A-1/5A-2",
      key({}) === "v1::PLAID::item1::transactions::transaction-persist", key({}));
    check("every registered key maps to itself today (no episode moves)",
      Object.entries(OPERATION_KEYS).every(([raw, resolved]) => raw === resolved));
  }

  // ── 6. Nothing about semantics or resolution moved ──────────────────────────
  console.log("6. semantics stay derived; no resolver was introduced");
  {
    check("nature is still derived from the semantics authority",
      classifySyncIssue({ kind: "REMOVED_TOMBSTONE", provider: "PLAID", detail: {} }).nature === "event" &&
      classifySyncIssue({ kind: "UPSERT_ERROR", provider: "PLAID", plaidTransactionId: "t",
                          detail: { stage: "transaction-persist" } }).nature === "condition");
    const ok = code("lib/platform/incidents/operation-key.ts");
    check("the registry stores no severity/domain/nature",
      !/severity|SyncIssueSeverity|nature|domain/i.test(ok.replace(/OPERATION_KEY|operation key/gi, "")));
    check("the registry introduces no resolution kind",
      !/AUTOMATIC_RECOVERY|resolutionKind|resolvedAt/.test(ok));
    // No taxonomy yet — 5B-1 owns that.
    const schema = readFileSync(path.join(ROOT, "prisma/schema.prisma"), "utf8");
    const en = schema.slice(schema.indexOf("enum SyncIssueKind"), schema.indexOf("}", schema.indexOf("enum SyncIssueKind")));
    // This began as a 5B-0 scope fence ("no taxonomy yet"). OPS-2D-5B-1 added the
    // four typed kinds, which is the fence's own purpose being fulfilled rather
    // than violated — so it is restated as the ENDURING rule: taxonomy may grow,
    // but it must stay additive and must never reach identity.
    check("UPSERT_ERROR is retained — legacy rows keep the kind they were recorded under",
      /UPSERT_ERROR/.test(en));
    check("taxonomy growth is additive; no kind was removed",
      ["MISSING_ACCOUNT", "REMOVED_TOMBSTONE", "BALANCE_TX_MISMATCH", "INSTRUMENT_IDENTITY_CONFLICT"]
        .every((k) => en.includes(k)));
    check("no typed kind leaked into an incident key",
      !/PERSISTENCE_FAILED|WALLET_SYNC_FAILED|IMPORT_ROLLBACK_FAILED/.test(key({})));
  }

  // ── 7. One authority ────────────────────────────────────────────────────────
  console.log("7. one operation-key authority, consumed by identity only");
  {
    const prod = [...walk("lib"), ...walk("app"), ...walk("components")].filter((f) => !/\.test\.tsx?$/.test(f));
    const owners = prod.filter((f) => /export const OPERATION_KEYS/.test(code(f)));
    check("one registry", owners.length === 1, owners.join(", "));
    const consumers = prod.filter((f) => f !== "lib/platform/incidents/operation-key.ts")
      .filter((f) => /resolveOperationKey\(/.test(code(f)));
    check("only the lifecycle authority resolves operation keys",
      consumers.length === 1 && consumers[0] === "lib/platform/incidents/lifecycle.ts", consumers.join(", "));
    // BEHAVIOURAL, not a spelling pin. An earlier version matched the exact
    // assignment in lifecycle.ts, which would have failed on a harmless rename
    // while passing if the registry were bypassed in some other shape. Instead:
    // feed the real detection path an UNREGISTERED stage and observe the key. A
    // namespaced result is only reachable through resolveOperationKey, so this
    // proves the registry is in the identity path without caring how it is
    // written.
    const captured: string[] = [];
    const probeClient = {
      syncIssue: {
        findFirst: async () => null,
        create: async ({ data }: { data: { incidentKey: string | null } }) => {
          if (data.incidentKey) captured.push(data.incidentKey);
          return { id: "x" };
        },
        update: async () => ({ id: "x" }),
      },
      syncIssueOccurrence: { create: async () => ({ id: "o" }) },
    };
    await recordIncidentObservation(
      { kind: "UPSERT_ERROR", plaidItemId: "item1", plaidTransactionId: "t",
        detail: { stage: "a-stage-nobody-registered", cursorBlocking: true } },
      probeClient as never,
      async () => null,
    );
    check("the lifecycle routes identity through the registry (unknown stage is namespaced)",
      captured.length === 1 && captured[0].endsWith(`::${UNREGISTERED_PREFIX}a-stage-nobody-registered`),
      captured.join(", "));
  }

  if (failures > 0) { console.error(`\noperation-key.test: ${failures} failure(s).`); process.exit(1); }
  console.log("\noperation-key.test: all passed.");
}

void main();
