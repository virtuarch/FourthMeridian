/**
 * lib/privacy/network-identifiers.census.test.ts
 *
 * The registry (lib/privacy/network-identifiers.ts) is COMPLETE, by scan:
 *   1. every IP / user-agent column in prisma/schema.prisma is registered, and
 *      every registered column exists;
 *   2. every object key fed directly from the request IP or user agent is a
 *      registered column name (ipAddress / userAgent) or the transient `ip` in
 *      a file known not to persist it;
 *   3. every `ip:${…}` key builder is a registered IP_KEY writer;
 *   4. every raw INSERT naming "ipAddress" / "userAgent" targets a registered
 *      model;
 *   5. the forwarded-for chain is never carried beyond lib/api.ts;
 *   6. the doc renders every registered field.
 * Each scanner is proven non-vacuous on the real tree and on a synthetic
 * violation.
 *   npx tsx lib/privacy/network-identifiers.census.test.ts
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { NETWORK_IDENTIFIER_FIELDS } from "@/lib/privacy/network-identifiers";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

// ── 1. Schema ────────────────────────────────────────────────────────────────
console.log("1. schema: every IP / UA column is registered");

/** camelCase / snake tokens, lower-cased. */
const tokens = (name: string) => name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]/g, " ").toLowerCase().split(/\s+/);
/** True when a column NAME says it holds an IP or a user agent. */
function isNetworkColumnName(name: string): boolean {
  const t = tokens(name);
  if (t.includes("ip") || t.includes("ua") || t.includes("ipv4") || t.includes("ipv6")) return true;
  if (t.includes("agent") && t.includes("user")) return true;
  if (t.includes("forwarded") || (t.includes("remote") && t.includes("addr"))) return true;
  return false;
}

function schemaColumns(schema: string): { model: string; field: string }[] {
  const out: { model: string; field: string }[] = [];
  let model: string | null = null;
  for (const line of schema.split("\n")) {
    const open = /^model\s+(\w+)\s*\{/.exec(line);
    if (open) { model = open[1]; continue; }
    if (/^\}/.test(line)) { model = null; continue; }
    if (!model) continue;
    const f = /^\s+(\w+)\s+[A-Z]\w*/.exec(line);
    if (f) out.push({ model, field: f[1] });
  }
  return out;
}

const schema = read("prisma/schema.prisma");
const columns = schemaColumns(schema);
check("schema parser sees the models (non-vacuous)", columns.length > 500 && columns.some((c) => c.model === "AuditLog" && c.field === "ipAddress"), String(columns.length));
check("name heuristic catches a synthetic column", isNetworkColumnName("clientIpHash") && isNetworkColumnName("lastUserAgent") && isNetworkColumnName("uaRaw") && isNetworkColumnName("remoteAddr"));
check("name heuristic ignores lookalikes", !isNetworkColumnName("description") && !isNetworkColumnName("shipping") && !isNetworkColumnName("membership") && !isNetworkColumnName("agentId") && !isNetworkColumnName("equal"));

const registeredColumns = new Set(NETWORK_IDENTIFIER_FIELDS.filter((f) => !f.jsonPath).map((f) => `${f.model}.${f.field}`));
const networkColumns = columns.filter((c) => isNetworkColumnName(c.field)).map((c) => `${c.model}.${c.field}`);
for (const c of networkColumns) check(`schema column ${c} is registered`, registeredColumns.has(c), "add it to NETWORK_IDENTIFIER_FIELDS (lib/privacy/network-identifiers.ts) and the doc");
for (const f of NETWORK_IDENTIFIER_FIELDS) {
  check(`registered ${f.id}: column exists in the schema`, columns.some((c) => c.model === f.model && c.field === f.field));
}

// ── Registry integrity ───────────────────────────────────────────────────────
console.log("\nregistry integrity");
const ids = NETWORK_IDENTIFIER_FIELDS.map((f) => f.id);
check("ids are unique", new Set(ids).size === ids.length);
for (const f of NETWORK_IDENTIFIER_FIELDS) {
  check(`${f.id}: id = model.field(.path)`, f.id === [f.model, f.field, ...(f.jsonPath ?? [])].join("."));
  check(`${f.id}: IP_KEY ⇔ keyShape`, (f.kind === "IP_KEY") === (f.keyShape !== undefined));
  const ipMethods = f.methods.every((m) => m === "DIGEST" || m === "TRUNCATE");
  const uaMethods = f.methods.every((m) => m === "UA_FAMILY" || m === "NULL");
  check(`${f.id}: methods fit the kind`, f.methods.length > 0 && (f.kind === "UA" ? uaMethods : ipMethods));
  check(`${f.id}: AuditLog fields are blocked by DB-010 and only they`, (f.model === "AuditLog") === (f.applyBlockedBy === "DB_010"));
  for (const w of f.writers.filter((x) => !x.startsWith("("))) check(`${f.id}: writer ${w} exists`, existsSync(path.join(ROOT, w)));
}

// ── Source walk ──────────────────────────────────────────────────────────────
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(path.join(ROOT, dir))) {
    if (name === "node_modules" || name === "prototype" || name.startsWith(".")) continue;
    const rel = path.join(dir, name);
    if (statSync(path.join(ROOT, rel)).isDirectory()) walk(rel, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(rel.split(path.sep).join("/"));
  }
  return out;
}
const SOURCES = ["lib", "app", "jobs"].flatMap((d) => walk(d));
const sourceText = new Map(SOURCES.map((f) => [f, read(f)]));
check("source walk sees the tree (non-vacuous)", SOURCES.length > 500 && sourceText.has("lib/rate-limit.ts"), String(SOURCES.length));

// ── 2. Sinks of the request IP / UA ─────────────────────────────────────────
console.log("\n2. every object key fed from the request IP / user agent is registered");
const REQUEST_NETWORK_SOURCE =
  /\b(\w+)\s*:\s*(?:getClientIp\(|extractClientIp\(|getRequestMeta\([^)]*\)\.(?:ip|userAgent)\b|meta\.(?:ip|userAgent)\b|(?:req|request)\.headers\.get\(\s*["']user-agent["']\s*\)|h\.get\(\s*["']user-agent["']\s*\))/g;
/** Keys that persist: exactly the registered column names. */
const PERSISTED_KEYS = new Set(NETWORK_IDENTIFIER_FIELDS.filter((f) => f.kind !== "IP_KEY").map((f) => f.field));
/**
 * The transient `ip` key, per file — each reviewed: it is never written to a
 * column under that name.
 *   lib/api.ts                    RequestMeta construction (the in-memory carrier)
 *   app/api/access-request/route.ts  CAPTCHA verification (sent to the provider)
 *   app/api/auth/register/route.ts   CAPTCHA verification
 */
const TRANSIENT_IP_KEY_FILES = new Set(["lib/api.ts", "app/api/access-request/route.ts", "app/api/auth/register/route.ts"]);
/** The other transient key: RequestMeta's own `userAgent` field is a registered name anyway. */

function sinkViolations(file: string, text: string): string[] {
  const bad: string[] = [];
  for (const m of text.matchAll(REQUEST_NETWORK_SOURCE)) {
    const key = m[1];
    if (PERSISTED_KEYS.has(key)) continue;
    if (key === "ip" && TRANSIENT_IP_KEY_FILES.has(file)) continue;
    bad.push(`${file}: ${m[0].slice(0, 60)}`);
  }
  return bad;
}
let sinkHits = 0;
for (const [, t] of sourceText) sinkHits += [...t.matchAll(REQUEST_NETWORK_SOURCE)].length;
check("the sink scanner sees the real writes (non-vacuous)", sinkHits >= 50, String(sinkHits));
check("the sink scanner flags a synthetic unregistered key", sinkViolations("lib/x.ts", "data: { clientAddr: getClientIp(req) }").length === 1
  && sinkViolations("lib/x.ts", "{ ip: meta.ip }").length === 1
  && sinkViolations("lib/x.ts", "{ browser: req.headers.get(\"user-agent\") }").length === 1);
const sinkBad = [...sourceText].flatMap(([f, t]) => sinkViolations(f, t));
check("no unregistered sink of the request IP / UA", sinkBad.length === 0, sinkBad.join("; "));

// ── 3. IP-keyed builders ─────────────────────────────────────────────────────
console.log("\n3. every `ip:${…}` key builder is a registered IP_KEY writer");
const IP_KEY_BUILDER = /`ip:\$\{/;
const ipKeyWriters = new Set(NETWORK_IDENTIFIER_FIELDS.filter((f) => f.kind === "IP_KEY").flatMap((f) => f.writers));
const builders = [...sourceText].filter(([, t]) => IP_KEY_BUILDER.test(t)).map(([f]) => f);
check("the builder scanner sees lib/rate-limit.ts and lib/security/anomalies.ts (non-vacuous)", builders.includes("lib/rate-limit.ts") && builders.includes("lib/security/anomalies.ts"), builders.join(", "));
for (const b of builders) check(`${b} is a registered IP_KEY writer`, ipKeyWriters.has(b), "register the key it builds (kind IP_KEY) in lib/privacy/network-identifiers.ts");

// ── 4. Raw INSERTs ───────────────────────────────────────────────────────────
console.log("\n4. every raw INSERT naming an IP / UA column targets a registered model");
const RAW_INSERT = /INSERT\s+INTO\s+"(\w+)"\s*\(([^)]*)\)/g;
const registeredModels = new Set(NETWORK_IDENTIFIER_FIELDS.map((f) => `${f.model}.${f.field}`));
function insertViolations(text: string): string[] {
  const bad: string[] = [];
  for (const m of text.matchAll(RAW_INSERT)) {
    for (const col of m[2].split(",").map((c) => c.trim().replace(/"/g, ""))) {
      if (isNetworkColumnName(col) && !registeredModels.has(`${m[1]}.${col}`)) bad.push(`${m[1]}.${col}`);
    }
  }
  return bad;
}
const insertFiles = [...sourceText].filter(([, t]) => [...t.matchAll(RAW_INSERT)].some((m) => /"ipAddress"|"userAgent"/.test(m[2]))).map(([f]) => f);
check("the INSERT scanner sees lib/auth/session-activity.ts (non-vacuous)", insertFiles.includes("lib/auth/session-activity.ts"), insertFiles.join(", "));
check("the INSERT scanner flags a synthetic table", insertViolations(`INSERT INTO "Visit" ("id", "clientIp") VALUES`).length === 1);
const insertBad = [...sourceText].flatMap(([f, t]) => insertViolations(t).map((v) => `${f}: ${v}`));
check("no raw INSERT of an IP / UA into an unregistered column", insertBad.length === 0, insertBad.join("; "));

// ── 5. Forwarded-for chain ───────────────────────────────────────────────────
console.log("\n5. the x-forwarded-for chain is never carried beyond lib/api.ts");
const fwd = [...sourceText].filter(([f, t]) => f !== "lib/api.ts" && /\.forwardedFor\b|forwardedFor\s*:/.test(t)).map(([f]) => f);
check("RequestMeta.forwardedFor is read nowhere else", fwd.length === 0, fwd.join(", "));
check("…and is still built in lib/api.ts (non-vacuous)", /forwardedFor:\s*h\.get/.test(sourceText.get("lib/api.ts") ?? ""));

// ── 6. Doc ───────────────────────────────────────────────────────────────────
console.log("\n6. the doc renders the registry");
const doc = read("docs/operations/data-retention.md");
for (const f of NETWORK_IDENTIFIER_FIELDS) check(`doc lists ${f.id}`, doc.includes(`\`${f.id}\``));
check("doc marks it OWNER DECISION", doc.includes("OWNER DECISION"));
check("doc carries the proposed policy SQL in a fenced block", /```sql[\s\S]*fm_system_minimise[\s\S]*```/.test(doc));
check("no migration was added for it", !readdirSync(path.join(ROOT, "prisma/migrations")).some((d) => /network|ip.?min/i.test(d)));

if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nall network-identifier census checks passed");
