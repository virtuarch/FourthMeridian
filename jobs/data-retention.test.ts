/**
 * jobs/data-retention.test.ts  (PRIV-003 · DB-001 · PRIV-012)
 *
 * The retention schedule over a FAKE CLOCK and an in-memory client that
 * evaluates each rule's where-clause on real rows. Standalone tsx:
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs jobs/data-retention.test.ts
 */

import { readFileSync } from "node:fs";
import {
  runDataRetention, retentionCutoffFor, RETENTION_RULES, RETENTION_BATCH, RETENTION_MAX_BATCHES,
  uaFamily, networkDigest, resolveNetworkDigestKey, canonicalIp, minimiseAuditNetwork, runBetaIntakeNetworkMinimisation,
  BETA_INTAKE_AUDIT_ACTION, MINIMISE_BATCH, MINIMISE_MAX_BATCHES,
  type RetentionClient, type RetentionTable,
} from "@/jobs/data-retention";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const NOW = new Date("2026-10-22T07:30:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);

// ── A where-clause evaluator covering the operators the rules use ────────────
type Row = Record<string, unknown> & { id: string };
function matches(row: Row, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([k, cond]) => {
    if (k === "AND") return (cond as Record<string, unknown>[]).every((w) => matches(row, w));
    if (k === "OR") return (cond as Record<string, unknown>[]).some((w) => matches(row, w));
    const v = row[k];
    if (cond === null) return v === null || v === undefined;
    if (typeof cond !== "object" || cond instanceof Date) return v === cond;
    const c = cond as { lt?: Date; not?: unknown; in?: unknown[]; none?: Record<string, unknown> };
    // A to-many relation filter (`items: { none: … }`): the row carries its children as an array.
    if (c.none) return !(Array.isArray(v) && (v as Row[]).some((child) => matches(child, c.none!)));
    if (c.in && !c.in.includes(v)) return false;
    if ("not" in c && (c.not === null ? (v === null || v === undefined) : v === c.not)) return false;
    if (c.lt && !(v instanceof Date && v.getTime() < c.lt.getTime())) return false;
    return true;
  });
}

function makeClient(tables: Partial<Record<RetentionTable, Row[]>>, opts: { failOn?: RetentionTable } = {}) {
  const data = Object.fromEntries(RETENTION_RULES.map((r) => [r.table, [...(tables[r.table] ?? [])]])) as Record<RetentionTable, Row[]>;
  const calls: Array<{ table: string; op: string; where: Record<string, unknown> }> = [];
  const client = Object.fromEntries(RETENTION_RULES.map((r) => [r.table, {
    async findMany({ where, take }: { where: Record<string, unknown>; take: number }) {
      if (opts.failOn === r.table) throw new Error("boom");
      calls.push({ table: r.table, op: "find", where });
      return data[r.table].filter((row) => matches(row, where)).slice(0, take).map((row) => ({ id: row.id }));
    },
    async deleteMany({ where }: { where: Record<string, unknown> }) {
      calls.push({ table: r.table, op: "delete", where });
      const before = data[r.table].length;
      data[r.table] = data[r.table].filter((row) => !matches(row, where));
      return { count: before - data[r.table].length };
    },
  }])) as unknown as RetentionClient;
  return { client, data, calls };
}

const quiet = <T,>(fn: () => Promise<T>) => {
  const o = { log: console.log, error: console.error };
  console.log = () => {}; console.error = () => {};
  return fn().finally(() => Object.assign(console, o));
};

async function main() {
  console.log("the schedule");
  {
    const days = Object.fromEntries(RETENTION_RULES.map((r) => [r.table, r.days]));
    check("windows: sessions 30, AI 90, jobs 90, refresh 60, provider calls 60, webhooks 30, sync issues 90, usage 90, waitlist 180, briefs 90, automation runs 90",
      days.userSession === 30 && days.aiInvocation === 90 && days.jobRun === 90 && days.refreshExecution === 60 && days.providerCall === 60
      && days.plaidWebhookEvent === 30 && days.syncIssue === 90 && days.apiUsageCounter === 90 && days.betaAccessRequest === 180
      && days.betaAccessRequestEvent === 180 && days.dailyBrief === 90 && days.automationRun === 90 && days.commsProviderEvent === 90, JSON.stringify(days));
    check("cutoff is exactly N days before now", retentionCutoffFor({ days: 30 }, NOW).getTime() === daysAgo(30).getTime());
  }

  console.log("\nrows past their window go; everything else stays");
  {
    const { client, data } = makeClient({
      userSession: [
        { id: "s-old-revoked", revokedAt: daysAgo(31) }, { id: "s-new-revoked", revokedAt: daysAgo(29) },
        { id: "s-live-old", revokedAt: null, createdAt: daysAgo(400) },
      ],
      aiInvocation: [{ id: "ai-old", occurredAt: daysAgo(91) }, { id: "ai-new", occurredAt: daysAgo(89) }],
      jobRun: [{ id: "j-old", startedAt: daysAgo(91), status: "succeeded" }, { id: "j-old-running", startedAt: daysAgo(91), status: "running" }, { id: "j-new", startedAt: daysAgo(10), status: "failed" }],
      refreshExecution: [{ id: "r-old", startedAt: daysAgo(61) }, { id: "r-new", startedAt: daysAgo(59) }],
      providerCall: [{ id: "p-old", startedAt: daysAgo(61) }],
      plaidWebhookEvent: [{ id: "w-old", receivedAt: daysAgo(31) }, { id: "w-new", receivedAt: daysAgo(1) }],
      syncIssue: [
        { id: "si-resolved-old", resolved: true, resolvedAt: daysAgo(91), updatedAt: daysAgo(91) },
        { id: "si-resolved-legacy", resolved: true, resolvedAt: null, updatedAt: daysAgo(100) },
        { id: "si-open-old", resolved: false, resolvedAt: null, updatedAt: daysAgo(300) },
        { id: "si-resolved-new", resolved: true, resolvedAt: daysAgo(5), updatedAt: daysAgo(5) },
      ],
      apiUsageCounter: [{ id: "u-old", day: daysAgo(91) }, { id: "u-new", day: daysAgo(1) }],
      betaAccessRequest: [
        { id: "b-denied-old", status: "DENIED", decidedAt: daysAgo(181), createdAt: daysAgo(200) },
        { id: "b-denied-new", status: "DENIED", decidedAt: daysAgo(10), createdAt: daysAgo(400) },
        { id: "b-pending-old", status: "PENDING", decidedAt: null, createdAt: daysAgo(181) },
        { id: "b-pending-new", status: "PENDING", decidedAt: null, createdAt: daysAgo(30) },
        { id: "b-approved-expired", status: "APPROVED", inviteExpiresAt: daysAgo(181), createdAt: daysAgo(200) },
        { id: "b-redeemed-old", status: "REDEEMED", decidedAt: daysAgo(400), createdAt: daysAgo(400) },
      ],
      betaAccessRequestEvent: [{ id: "e-old", receivedAt: daysAgo(181) }, { id: "e-new", receivedAt: daysAgo(1) }],
      dailyBrief: [{ id: "d-old", briefDay: daysAgo(91) }, { id: "d-new", briefDay: daysAgo(1) }],
      commsProviderEvent: [{ id: "cpe-old", receivedAt: daysAgo(91) }, { id: "cpe-edge", receivedAt: daysAgo(89) }, { id: "cpe-new", receivedAt: daysAgo(1) }],
    });
    const r = await quiet(() => runDataRetention(client, NOW));
    const left = (t: RetentionTable) => data[t].map((x) => x.id).sort().join();
    check("UserSession: revoked > 30 d deleted; recently revoked and LIVE sessions kept", left("userSession") === "s-live-old,s-new-revoked", left("userSession"));
    check("AiInvocation > 90 d deleted", left("aiInvocation") === "ai-new");
    check("JobRun > 90 d deleted, but never a `running` row", left("jobRun") === "j-new,j-old-running", left("jobRun"));
    check("RefreshExecution > 60 d deleted (children by FK cascade)", left("refreshExecution") === "r-new");
    check("ProviderCall > 60 d deleted", left("providerCall") === "");
    check("PlaidWebhookEvent > 30 d deleted", left("plaidWebhookEvent") === "w-new");
    check("SyncIssue: resolved > 90 d (incl. legacy rows without resolvedAt) deleted; OPEN issues kept at any age", left("syncIssue") === "si-open-old,si-resolved-new", left("syncIssue"));
    check("ApiUsageCounter > 90 d deleted", left("apiUsageCounter") === "u-new");
    check("waitlist: denied/pending/expired-approval > 180 d deleted; recent and REDEEMED kept", left("betaAccessRequest") === "b-denied-new,b-pending-new,b-redeemed-old", left("betaAccessRequest"));
    check("waitlist events > 180 d deleted", left("betaAccessRequestEvent") === "e-new");
    check("DailyBrief > 90 d deleted", left("dailyBrief") === "d-new");
    check("CommsProviderEvent > 90 d deleted (Comms Center C); 89 d and recent kept", left("commsProviderEvent") === "cpe-edge,cpe-new", left("commsProviderEvent"));
    check("totals add up (1+1+1+1+1+1+2+1+3+1+1+1)", r.totalDeleted === 15, `${r.totalDeleted}`);
    check("every table reports exhausted", RETENTION_RULES.every((rule) => r[rule.table].exhausted));
  }

  console.log("\nautomation runs: never one that is RUNNING or holds an item that can still send (PRE-FLIP R5)");
  {
    const run = (id: string, age: number, status: string, itemStatuses: string[]) => ({ id, startedAt: daysAgo(age), status, items: itemStatuses.map((st, i) => ({ id: `${id}-i${i}`, status: st })) });
    const { client, data } = makeClient({ automationRun: [
      run("ar-done", 91, "SUCCEEDED", ["SENT", "SUPPRESSED", "CANCELLED", "DEAD"]),
      run("ar-halted", 91, "HALTED", ["CANCELLED"]),
      run("ar-empty", 91, "SUCCEEDED", []),
      run("ar-running", 91, "RUNNING", ["SENT"]),
      run("ar-scheduled", 91, "SUCCEEDED", ["SENT", "SCHEDULED"]),
      run("ar-sending", 91, "SUCCEEDED", ["SENDING"]),
      run("ar-failed", 91, "SUCCEEDED", ["FAILED"]),
      run("ar-new", 89, "SUCCEEDED", ["SENT"]),
    ] });
    const r = await quiet(() => runDataRetention(client, NOW));
    const left = data.automationRun.map((x) => x.id).sort().join();
    check("finished runs > 90 d whose items are all terminal are deleted; RUNNING, SCHEDULED / SENDING / FAILED holders and a recent run are kept",
      left === "ar-failed,ar-new,ar-running,ar-scheduled,ar-sending" && r.automationRun.deleted === 3, `${left} deleted=${r.automationRun.deleted}`);
    const rule = RETENTION_RULES.find((x) => x.table === "automationRun")!;
    const w = rule.where(daysAgo(90)) as { status?: { not?: string }; items?: { none?: { status?: { in?: string[] } } } };
    check("the where(cutoff) itself excludes RUNNING runs and runs with SCHEDULED, SENDING or FAILED items",
      w.status?.not === "RUNNING" && [...(w.items?.none?.status?.in ?? [])].sort().join() === "FAILED,SCHEDULED,SENDING", JSON.stringify(w));
  }

  console.log("\nbatching and isolation");
  {
    const many = Array.from({ length: RETENTION_BATCH * RETENTION_MAX_BATCHES + 5 }, (_, i) => ({ id: `w${i}`, receivedAt: daysAgo(40) }));
    const { client, data, calls } = makeClient({ plaidWebhookEvent: many });
    const r = await quiet(() => runDataRetention(client, NOW));
    check("at most MAX_BATCHES per table per run; the remainder is reported, not lost", r.plaidWebhookEvent.batches === RETENTION_MAX_BATCHES
      && r.plaidWebhookEvent.exhausted === false && data.plaidWebhookEvent.length === 5);
    const del = calls.find((c) => c.op === "delete");
    check("each delete repeats the age predicate alongside the id list (a row that changed in between survives)",
      !!del && Array.isArray(del.where.AND) && (del.where.AND as unknown[]).length === 2);
  }
  {
    const { client, data } = makeClient({ aiInvocation: [{ id: "x", occurredAt: daysAgo(100) }], jobRun: [{ id: "j", startedAt: daysAgo(100), status: "succeeded" }] }, { failOn: "aiInvocation" });
    const r = await quiet(() => runDataRetention(client, NOW));
    check("one table failing does not stop the others", !!r.aiInvocation.error && data.jobRun.length === 0 && data.aiInvocation.length === 1);
  }

  {
    const { client, data, calls } = makeClient({ plaidWebhookEvent: [{ id: "w1", receivedAt: daysAgo(40) }, { id: "w2", receivedAt: daysAgo(10) }] });
    const r = await quiet(() => runDataRetention(client, NOW, undefined, { dryRun: true }));
    check("dryRun: delete rules report would-delete counts and delete nothing",
      r.dryRun === true && r.plaidWebhookEvent.deleted === 1 && r.totalDeleted === 1 && data.plaidWebhookEvent.length === 2
      && !calls.some((c) => c.op === "delete"));
  }

  console.log("\nwiring");
  {
    const strip = (p: string) => readFileSync(p, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    check("the registered purge-trash body runs the retention schedule", /runDataRetention\(/.test(strip("jobs/purge-trash.ts")));
    check("retention defaults to the system principal", /\.systemDb as unknown as RetentionClient/.test(strip("jobs/data-retention.ts")));
    check("no financial table is in the schedule", !RETENTION_RULES.some((r) => /transaction|financialAccount|snapshot|holding|position/i.test(r.table)));
  }

  console.log("\nR2 — uaFamily (pure)");
  {
    const cases: Array<[string | null, string]> = [
      [null, "empty"], ["   ", "empty"],
      ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15", "browser"],
      ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36", "browser"],
      ["Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0", "browser"],
      ["Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/129.0 Safari/537.36", "headless"],
      ["curl/8.4.0", "script"], ["python-requests/2.31.0", "script"], ["Go-http-client/2.0", "script"], ["node", "script"],
      ["Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)", "script"],
      ["SomethingElse/1.0", "other"],
    ];
    for (const [ua, want] of cases) check(`uaFamily(${JSON.stringify(ua)?.slice(0, 40)}) = ${want}`, uaFamily(ua) === want, uaFamily(ua));
  }

  console.log("\nR2 — minimiseAuditNetwork (pure)");
  {
    const K1 = "k".repeat(32), K2 = "z".repeat(40);
    const key = resolveNetworkDigestKey({ BETA_INTAKE_HASH_KEY_V1: K1 })!;
    const row = { id: "a1", ipAddress: "203.0.113.9", userAgent: "curl/8.4.0", metadata: { emailHash: "h", consentNoticeVersion: "v1" } };
    const m = minimiseAuditNetwork(row, key, NOW);
    check("raw ipAddress + userAgent nulled", m.ipAddress === null && m.userAgent === null);
    check("existing metadata kept", m.metadata.emailHash === "h" && m.metadata.consentNoticeVersion === "v1");
    check("uaFamily recorded", m.metadata.uaFamily === "script");
    check("networkDigest = HMAC-SHA256 hex, never the IP", typeof m.metadata.networkDigest === "string"
      && /^[0-9a-f]{64}$/.test(m.metadata.networkDigest as string) && !JSON.stringify(m).includes("203.0.113.9"));
    check("digest is keyed: same IP, same key → same digest; other key → different",
      networkDigest("203.0.113.9", key.key) === m.metadata.networkDigest
      && networkDigest("203.0.113.9", Buffer.from(K2)) !== m.metadata.networkDigest);
    check("networkDigestKeyVersion stored beside the digest (default v1) + minimisation instant",
      m.metadata.networkDigestKeyVersion === "v1" && m.metadata.networkMinimisedAt === NOW.toISOString() && !("networkDigestKeyId" in m.metadata));
    const noKey = minimiseAuditNetwork(row, null, NOW);
    check("no secret → NO digest at all (no unkeyed fingerprint), fields still nulled",
      !("networkDigest" in noKey.metadata) && noKey.ipAddress === null && noKey.metadata.uaFamily === "script");
    const origWarn = console.warn; let warns = 0; console.warn = () => { warns++; };
    const unset = resolveNetworkDigestKey({ NEXTAUTH_SECRET: "x".repeat(64) });
    const unset2 = resolveNetworkDigestKey({ NEXTAUTH_SECRET: "x".repeat(64) });
    const short = resolveNetworkDigestKey({ BETA_INTAKE_HASH_KEY_V1: "short" });
    const badVer = resolveNetworkDigestKey({ BETA_INTAKE_HASH_KEY_VERSION: "latest", BETA_INTAKE_HASH_KEY_V1: K1 });
    const v2Missing = resolveNetworkDigestKey({ BETA_INTAKE_HASH_KEY_VERSION: "v2", BETA_INTAKE_HASH_KEY_V1: K1 });
    console.warn = origWarn;
    check("key unset → null, and NEVER falls back to NEXTAUTH_SECRET", unset === null && unset2 === null);
    check("unset is logged once (repeat calls do not re-log the same reason)", warns === 4, `warns=${warns}`);
    check("short key, malformed version, or the selected version's key missing → null", short === null && badVer === null && v2Missing === null);
    const rot = resolveNetworkDigestKey({ BETA_INTAKE_HASH_KEY_VERSION: "v2", BETA_INTAKE_HASH_KEY_V1: K1, BETA_INTAKE_HASH_KEY_V2: K2 })!;
    check("rotation: VERSION=v2 selects BETA_INTAKE_HASH_KEY_V2", rot.version === "v2" && rot.key.equals(Buffer.from(K2)));
    const old = minimiseAuditNetwork({ id: "a1", ipAddress: null, userAgent: null, metadata: m.metadata }, rot, NOW);
    check("rotation: a row minimised under v1 keeps its v1 digest and label", old.metadata.networkDigest === m.metadata.networkDigest && old.metadata.networkDigestKeyVersion === "v1");
    const fresh = minimiseAuditNetwork(row, rot, NOW);
    check("rotation: new minimisations carry v2 digests labelled v2", fresh.metadata.networkDigestKeyVersion === "v2" && fresh.metadata.networkDigest !== m.metadata.networkDigest);
    const again = minimiseAuditNetwork({ id: "a1", ipAddress: null, userAgent: null, metadata: m.metadata }, key, new Date(NOW.getTime() + 86_400_000));
    check("idempotent: re-minimising keeps digest, family and first instant", again.metadata.networkDigest === m.metadata.networkDigest
      && again.metadata.uaFamily === "script" && again.metadata.networkMinimisedAt === NOW.toISOString());
    check("canonicalIp: IPv4-mapped IPv6 → IPv4 (text and hex forms)",
      canonicalIp("::ffff:203.0.113.9") === "203.0.113.9" && canonicalIp("::FFFF:203.0.113.9") === "203.0.113.9"
      && canonicalIp("0:0:0:0:0:ffff:203.0.113.9") === "203.0.113.9" && canonicalIp("::ffff:cb00:7109") === "203.0.113.9",
      canonicalIp("::ffff:cb00:7109"));
    check("canonicalIp: IPv6 lowercased + compressed", canonicalIp(" 2001:DB8:0:0:0:0:0:1 ") === "2001:db8::1" && canonicalIp("[2001:db8::1]") === "2001:db8::1");
    check("canonicalIp: IPv4 and junk pass through trimmed", canonicalIp(" 198.51.100.7 ") === "198.51.100.7" && canonicalIp("Unknown") === "unknown");
    check("digest: one address, one digest across spellings",
      networkDigest("::ffff:203.0.113.9", key.key) === networkDigest("203.0.113.9", key.key)
      && networkDigest("2001:DB8::0001", key.key) === networkDigest("2001:db8::1", key.key));
    check("null metadata → object", minimiseAuditNetwork({ ...row, metadata: null }, key, NOW).metadata.uaFamily === "script");
  }

  console.log("\nR2 — runBetaIntakeNetworkMinimisation (batch selection)");
  {
    const mk = (id: string, age: number, over: Record<string, unknown> = {}) =>
      ({ id, action: BETA_INTAKE_AUDIT_ACTION, createdAt: daysAgo(age), ipAddress: "198.51.100.1", userAgent: "curl/8", metadata: { emailHash: id }, ...over });
    const rows: Row[] = [
      mk("old", 91), mk("young", 89),
      mk("other-action", 200, { action: "LOGIN" }),
      mk("done", 120, { ipAddress: null, userAgent: null }),
      mk("ua-only", 100, { ipAddress: null }),
    ];
    const calls: string[] = [];
    const auditLog = {
      async findMany({ where, take }: { where: Record<string, unknown>; take: number }) {
        calls.push("find");
        return rows.filter((r) => matches(r, where))
          .sort((a, b) => (a.createdAt as Date).getTime() - (b.createdAt as Date).getTime())
          .slice(0, take).map((r) => ({ id: r.id, ipAddress: r.ipAddress as string | null, userAgent: r.userAgent as string | null, metadata: r.metadata }));
      },
      async updateMany({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) {
        calls.push("update");
        let n = 0;
        for (const r of rows) if (matches(r, where)) { Object.assign(r, data); n++; }
        return { count: n };
      },
      async count({ where }: { where: Record<string, unknown> }) { calls.push("count"); return rows.filter((r) => matches(r, where)).length; },
      async deleteMany() { calls.push("DELETE"); return { count: 0 }; },
    };
    const key = resolveNetworkDigestKey({ BETA_INTAKE_HASH_KEY_V1: "k".repeat(32) });

    const dry = await quiet(() => runBetaIntakeNetworkMinimisation({ auditLog }, NOW, { dryRun: true, key }));
    check("dry run counts the 2 due rows and writes nothing", dry.dryRun && dry.minimised === 2 && !calls.includes("update")
      && rows.find((r) => r.id === "old")!.ipAddress === "198.51.100.1", JSON.stringify(dry));

    const r1 = await quiet(() => runBetaIntakeNetworkMinimisation({ auditLog }, NOW, { key }));
    const by = (id: string) => rows.find((r) => r.id === id)!;
    check("selects only BETA_ACCESS_REQUESTED, >90 days, with a raw field left", r1.minimised === 2 && r1.exhausted, JSON.stringify(r1));
    check("the 91-day row is minimised with a digest", by("old").ipAddress === null && by("old").userAgent === null
      && typeof (by("old").metadata as Record<string, unknown>).networkDigest === "string");
    check("the UA-only row is minimised without a digest", by("ua-only").userAgent === null && !("networkDigest" in (by("ua-only").metadata as object)));
    check("the 89-day row and the other action are untouched", by("young").ipAddress === "198.51.100.1" && by("other-action").ipAddress === "198.51.100.1");
    check("never deletes", rows.length === 5 && !calls.includes("DELETE"));
    const r2 = await quiet(() => runBetaIntakeNetworkMinimisation({ auditLog }, NOW, { key }));
    check("idempotent: a second run finds nothing", r2.minimised === 0 && r2.exhausted);

    const many: Row[] = Array.from({ length: MINIMISE_BATCH * MINIMISE_MAX_BATCHES + 3 }, (_, i) => mk(`m${i}`, 95));
    rows.length = 0; rows.push(...many);
    const r3 = await quiet(() => runBetaIntakeNetworkMinimisation({ auditLog }, NOW, { key }));
    check("bounded: at most BATCH × MAX_BATCHES per run, remainder reported", r3.minimised === MINIMISE_BATCH * MINIMISE_MAX_BATCHES
      && r3.exhausted === false && rows.filter((r) => r.ipAddress !== null).length === 3, JSON.stringify(r3));

    // runDataRetention wires it in when the client has auditLog
    const { client } = makeClient({});
    rows.length = 0; rows.push(mk("w", 100));
    const dryFull = await quiet(() => runDataRetention(Object.assign(client, { auditLog }), NOW, undefined, { dryRun: true }));
    check("runDataRetention dryRun passes through: would-minimise counted, nothing written",
      dryFull.dryRun === true && dryFull.betaIntakeNetwork?.dryRun === true && dryFull.betaIntakeNetwork.minimised === 1
      && rows[0].ipAddress === "198.51.100.1", JSON.stringify(dryFull.betaIntakeNetwork));
    const full = await quiet(() => runDataRetention(Object.assign(client, { auditLog }), NOW));
    check("runDataRetention runs the minimisation (and still deletes nothing from AuditLog)",
      full.betaIntakeNetwork?.minimised === 1 && rows.length === 1, JSON.stringify(full.betaIntakeNetwork));
  }

  // The comms-delivery rollup always writes (rollups + deletes), so a DRY RUN must not touch it at all.
  {
    const touched: string[] = [];
    const spy = new Proxy({}, {
      get(_t, prop) {
        touched.push(String(prop));
        return () => { throw new Error("rollup client used"); };
      },
    }) as unknown as Parameters<typeof runDataRetention>[2];
    const { client } = makeClient({});
    const dry = await quiet(() => runDataRetention(client, NOW, spy, { dryRun: true }));
    check("dryRun with a comms client: the rollup is skipped (no result, client never touched)",
      dry.commsDelivery == null && touched.length === 0, JSON.stringify({ commsDelivery: dry.commsDelivery, touched }));
    const live = await quiet(() => runDataRetention(client, NOW, spy));
    check("…and a live run does call the rollup (control: the spy is wired)", live.commsDelivery != null && touched.length > 0,
      JSON.stringify({ commsDelivery: live.commsDelivery, touched: touched.slice(0, 3) }));
  }

  if (failures > 0) { console.error(`\n❌ data retention: ${failures} check(s) failed`); process.exit(1); }
  console.log("\n✅ data retention: all checks passed");
}

main().catch((e) => { console.error(e); process.exit(1); });
