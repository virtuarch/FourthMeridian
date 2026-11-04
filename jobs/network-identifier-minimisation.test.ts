/**
 * jobs/network-identifier-minimisation.test.ts
 *
 * The setting defaults OFF and OFF does nothing; dry_run is a read-only census
 * per field and age band; apply refuses every field (AuditLog with the DB-010
 * message); the job is not scheduled. In-memory client over a fake clock.
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs jobs/network-identifier-minimisation.test.ts
 */

import { readFileSync } from "node:fs";
import {
  runNetworkIdentifierMinimisation, resolveNetworkIdMinimisationMode, rawPresenceWhere, bandWhere,
  AGE_BANDS, NETWORK_ID_MINIMISATION_ENV, NETWORK_ID_MINIMISATION_DEFAULT, type CensusClient,
} from "@/jobs/network-identifier-minimisation";
import { NETWORK_IDENTIFIER_FIELDS, DB_010_REFUSAL, OWNER_DECISION_REFUSAL } from "@/lib/privacy/network-identifiers";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const NOW = new Date("2026-11-04T07:30:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);

// ── A where evaluator for the operators the census uses ─────────────────────
type Row = Record<string, unknown>;
function matches(row: Row, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([k, cond]) => {
    if (k === "AND") return (cond as Record<string, unknown>[]).every((w) => matches(row, w));
    if (k === "NOT") return !matches(row, cond as Record<string, unknown>);
    const v = row[k];
    if (typeof cond !== "object" || cond === null || cond instanceof Date) return v === cond;
    const c = cond as { not?: unknown; startsWith?: string; lte?: Date; gt?: Date; path?: string[]; string_starts_with?: string };
    if (c.path) {
      const inner = c.path.reduce<unknown>((o, p) => (o && typeof o === "object" ? (o as Row)[p] : undefined), v);
      return typeof inner === "string" && inner.startsWith(c.string_starts_with ?? "");
    }
    if ("not" in c && c.not === null && (v === null || v === undefined)) return false;
    if (c.startsWith !== undefined && !(typeof v === "string" && v.startsWith(c.startsWith))) return false;
    if (c.lte && !(v instanceof Date && v.getTime() <= c.lte.getTime())) return false;
    if (c.gt && !(v instanceof Date && v.getTime() > c.gt.getTime())) return false;
    return true;
  });
}

function makeClient(data: { auditLog?: Row[]; userSession?: Row[]; rateLimit?: Row[] }) {
  const calls: string[] = [];
  const writes: string[] = [];
  const delegate = (name: keyof CensusClient) => new Proxy({
    async count({ where }: { where: Record<string, unknown> }) { calls.push(name); return (data[name] ?? []).filter((r) => matches(r, where)).length; },
  }, {
    get(target, prop) {
      if (prop === "count") return target.count;
      // Any other method (update, delete, …) is a write attempt: record it and fail loudly.
      return () => { writes.push(`${name}.${String(prop)}`); throw new Error(`write ${String(prop)} attempted`); };
    },
  });
  const client = { auditLog: delegate("auditLog"), userSession: delegate("userSession"), rateLimit: delegate("rateLimit") } as CensusClient;
  return { client, calls, writes };
}

const DATA = {
  auditLog: [
    { action: "LOGIN", ipAddress: "192.0.2.1", userAgent: "Mozilla/5.0", metadata: null, createdAt: daysAgo(1) },
    { action: "LOGIN", ipAddress: "192.0.2.2", userAgent: null, metadata: null, createdAt: daysAgo(45) },
    { action: "LOGIN_FAILED", ipAddress: "2001:db8::1", userAgent: "curl/8", metadata: { reason: "invalid_password" }, createdAt: daysAgo(200) },
    { action: "SESSION_ACTIVE_DAY", ipAddress: null, userAgent: null, metadata: {}, createdAt: daysAgo(2) },
    { action: "SECURITY_ANOMALY_DETECTED", ipAddress: null, userAgent: null, metadata: { key: "ip:198.51.100.7", keyHash: "ip:h0" }, createdAt: daysAgo(100) },
    { action: "SECURITY_ANOMALY_DETECTED", ipAddress: null, userAgent: null, metadata: { key: "identifier:someone" }, createdAt: daysAgo(100) },
    // O-8: a digest-only IP key (`ip:h<32 hex>`) is not a raw value.
    { action: "SECURITY_ANOMALY_DETECTED", ipAddress: null, userAgent: null, metadata: { key: `ip:h${"a".repeat(32)}`, keyHash: `ip:h${"a".repeat(32)}` }, createdAt: daysAgo(100) },
  ],
  userSession: [
    { ipAddress: "203.0.113.5", userAgent: "Mozilla/5.0", createdAt: daysAgo(10) },
    { ipAddress: "203.0.113.6", userAgent: "Mozilla/5.0", createdAt: daysAgo(400) }, // expired, never revoked
  ],
  rateLimit: [
    { key: "ip:pre-login:192.0.2.9", windowStart: daysAgo(0.5) },
    { key: "user:abc:login", windowStart: daysAgo(0.5) },
  ],
};

async function main() {
  console.log("the setting");
  check("default is off", NETWORK_ID_MINIMISATION_DEFAULT === "off" && resolveNetworkIdMinimisationMode({}) === "off");
  check("empty → off", resolveNetworkIdMinimisationMode({ [NETWORK_ID_MINIMISATION_ENV]: "" }) === "off");
  for (const v of ["true", "1", "on", "yes", "dryrun", "APPLY!", "enabled"]) {
    check(`unrecognised ${JSON.stringify(v)} → off (fail closed)`, resolveNetworkIdMinimisationMode({ [NETWORK_ID_MINIMISATION_ENV]: v }) === "off");
  }
  check("dry_run (case/space-insensitive)", resolveNetworkIdMinimisationMode({ [NETWORK_ID_MINIMISATION_ENV]: " DRY_RUN " }) === "dry_run");
  check("apply", resolveNetworkIdMinimisationMode({ [NETWORK_ID_MINIMISATION_ENV]: "apply" }) === "apply");

  console.log("\nOFF does nothing");
  {
    const { client, calls, writes } = makeClient(DATA);
    const r = await runNetworkIdentifierMinimisation({ client, now: NOW, env: {} });
    check("mode off, ran false, nothing reported", r.mode === "off" && !r.ran && r.fields.length === 0 && r.written === 0);
    check("not one database call", calls.length === 0 && writes.length === 0, `${calls.length} reads, ${writes.length} writes`);
    const r2 = await runNetworkIdentifierMinimisation({ client, now: NOW, env: { [NETWORK_ID_MINIMISATION_ENV]: "true" } });
    check("an unrecognised value is also a no-op", !r2.ran && calls.length === 0);
  }
  {
    // OFF never even resolves the real database client.
    const r = await runNetworkIdentifierMinimisation({ now: NOW, env: {} });
    check("off without an injected client touches no database", !r.ran && r.fields.length === 0);
  }

  console.log("\nDRY RUN: read-only census per field and age band");
  {
    const { client, calls, writes } = makeClient(DATA);
    const r = await runNetworkIdentifierMinimisation({ client, now: NOW, env: { [NETWORK_ID_MINIMISATION_ENV]: "dry_run" } });
    const by = Object.fromEntries(r.fields.map((f) => [f.id, f]));
    check("one row per registered field", r.fields.length === NETWORK_IDENTIFIER_FIELDS.length && NETWORK_IDENTIFIER_FIELDS.every((f) => by[f.id]));
    check("counts only: no write attempted, none refused", writes.length === 0 && r.written === 0 && r.fields.every((f) => !f.refused && !f.error));
    check("one count per field per band", calls.length === NETWORK_IDENTIFIER_FIELDS.length * AGE_BANDS.length, String(calls.length));
    const c = (id: string) => JSON.stringify(by[id].counts);
    check("AuditLog.ipAddress bands", c("AuditLog.ipAddress") === JSON.stringify({ "<30d": 1, "30-90d": 1, "90-180d": 0, ">180d": 1 }), c("AuditLog.ipAddress"));
    check("AuditLog.userAgent bands", c("AuditLog.userAgent") === JSON.stringify({ "<30d": 1, "30-90d": 0, "90-180d": 0, ">180d": 1 }), c("AuditLog.userAgent"));
    check("AuditLog.metadata.key counts only RAW ip: anomaly keys (not the O-8 digest form)", c("AuditLog.metadata.key") === JSON.stringify({ "<30d": 0, "30-90d": 0, "90-180d": 1, ">180d": 0 }), c("AuditLog.metadata.key"));
    check("UserSession.ipAddress: the expired-never-revoked session shows in >180d", c("UserSession.ipAddress") === JSON.stringify({ "<30d": 1, "30-90d": 0, "90-180d": 0, ">180d": 1 }), c("UserSession.ipAddress"));
    check("RateLimit.key counts only ip: buckets", c("RateLimit.key") === JSON.stringify({ "<30d": 1, "30-90d": 0, "90-180d": 0, ">180d": 0 }), c("RateLimit.key"));
    check("the input data is unchanged", DATA.auditLog[0].ipAddress === "192.0.2.1" && DATA.rateLimit[0].key === "ip:pre-login:192.0.2.9");
  }

  console.log("\nAPPLY: refused for every field in this build");
  {
    const { client, writes } = makeClient(DATA);
    const r = await runNetworkIdentifierMinimisation({ client, now: NOW, env: { [NETWORK_ID_MINIMISATION_ENV]: "apply" } });
    check("nothing written", writes.length === 0 && r.written === 0);
    for (const f of r.fields) {
      const want = f.model === "AuditLog" ? DB_010_REFUSAL : OWNER_DECISION_REFUSAL;
      check(`${f.id} refused with the ${f.model === "AuditLog" ? "DB-010" : "owner-decision"} message`, f.refused === want);
    }
    check("the AuditLog refusal names the DB-010 policy extension and owner + S2 review",
      DB_010_REFUSAL.includes("requires the DB-010 policy extension (owner + S2 review)"));
    check("counts are still reported (read-only)", r.fields.every((f) => f.counts !== null));
  }

  console.log("\none field's failure never stops the others");
  {
    const { client } = makeClient(DATA);
    const broken = { ...client, rateLimit: { count: async () => { throw new Error("boom"); } } } as CensusClient;
    const r = await runNetworkIdentifierMinimisation({ client: broken, now: NOW, env: { [NETWORK_ID_MINIMISATION_ENV]: "dry_run" } });
    const rl = r.fields.find((f) => f.id === "RateLimit.key")!;
    check("the failing field reports its error", rl.error === "boom" && rl.counts === null);
    check("the others are counted", r.fields.filter((f) => f.id !== "RateLimit.key").every((f) => f.counts !== null));
  }

  console.log("\nbands are contiguous and disjoint");
  {
    const f = NETWORK_IDENTIFIER_FIELDS[0];
    for (const age of [0, 29.99, 30, 30.01, 90, 180, 180.01, 5000]) {
      const row = { [f.ageColumn]: daysAgo(age) };
      const hits = AGE_BANDS.filter((b) => matches(row, bandWhere(f, b, NOW)));
      check(`age ${age} d falls in exactly one band`, hits.length === 1, hits.map((b) => b.band).join(","));
    }
    check("every registered field has a presence filter", NETWORK_IDENTIFIER_FIELDS.every((x) => Object.keys(rawPresenceWhere(x)).length > 0));
  }

  console.log("\nnot scheduled");
  {
    const registry = readFileSync("lib/jobs/registry.ts", "utf8") + readFileSync("lib/jobs/registry.core.ts", "utf8");
    const vercel = readFileSync("vercel.json", "utf8");
    check("not in the job registry", !registry.includes("network-identifier-minimisation") && !registry.includes("runNetworkIdentifierMinimisation"));
    check("no cron names it", !vercel.includes("network"));
  }

  if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log("\nall network-identifier-minimisation checks passed");
}

main().catch((err) => { console.error(err); process.exit(1); });
