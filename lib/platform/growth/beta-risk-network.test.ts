/**
 * lib/platform/growth/beta-risk-network.test.ts  (S2 ruling on PR #374 — keyed beta-risk IP grouping)
 *
 * Pins: the same IP ⇒ the same group key; a raw row and a minimised row of the
 * same IP group together (the minimisation job's stored digest is taken as-is);
 * different IPs never group; no key ⇒ no grouping signal; and a census that no
 * md5 is ever applied to an IP on the beta-risk path.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/platform/growth/beta-risk-network.test.ts
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { minimiseAuditNetwork, networkDigest, type NetworkDigestKey } from "@/jobs/data-retention";
import { networkGroupKeyer, type AuditNetworkFields } from "./beta-risk-network";
import { loadBetaRisk, type BetaRiskDb } from "./beta-risk";
import { auditEmailHash } from "@/lib/audit";
import { SHARED_NETWORK_MIN_OTHERS } from "./beta-risk-core";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`); }
}

const KEY: NetworkDigestKey = { key: Buffer.from("k".repeat(40), "utf8"), version: "v1" };
const OTHER_KEY: NetworkDigestKey = { key: Buffer.from("q".repeat(40), "utf8"), version: "v1" };
const raw = (ip: string | null): AuditNetworkFields => ({ ip, storedDigest: null, storedVersion: null });
/** A row exactly as jobs/data-retention.ts minimiseAuditNetwork leaves it. */
const minimised = (ip: string, key: NetworkDigestKey = KEY): AuditNetworkFields => {
  const m = minimiseAuditNetwork({ id: "x", ipAddress: ip, userAgent: "ua", metadata: {} }, key, new Date()).metadata;
  return { ip: null, storedDigest: m.networkDigest as string, storedVersion: m.networkDigestKeyVersion as string };
};

console.log("keyer · the same IP gives the same group");
{
  const g = networkGroupKeyer(KEY);
  const a = g(raw("192.0.2.44"));
  check("deterministic", a !== null && a === g(raw("192.0.2.44")), a);
  check("canonical forms of one address agree (IPv4-mapped, whitespace)", a === g(raw("::ffff:192.0.2.44")) && a === g(raw(" 192.0.2.44 ")));
  check("IPv6 compression forms agree", g(raw("2001:db8::1")) === g(raw("2001:0DB8:0:0:0:0:0:1")));
  check("the key is <version>:<64 hex> and contains no address", /^v1:[0-9a-f]{64}$/.test(a ?? "") && !(a ?? "").includes("192"), a);
  check("it is the beta-intake digest itself", a === `v1:${networkDigest("192.0.2.44", KEY.key)}`);
}

console.log("keyer · minimised and raw rows of the same IP group together");
{
  const g = networkGroupKeyer(KEY);
  check("minimised row → the same key as the raw row", g(minimised("192.0.2.44")) === g(raw("192.0.2.44")));
  check("…for IPv6 too", g(minimised("2001:db8::7")) === g(raw("2001:db8:0::7")));
  check("a stored digest under another key version is not used", g({ ...minimised("192.0.2.44"), storedVersion: "v2" }) === null);
  check("a malformed stored digest is not used", g({ ip: null, storedDigest: "nothex", storedVersion: "v1" }) === null);
  check("a stored digest of the \"unknown\" sentinel is refused", g(minimised("unknown")) === null && g(raw("unknown")) === null && g(raw("  ")) === null && g(raw(null)) === null);
}

console.log("keyer · different IPs do not group");
{
  const g = networkGroupKeyer(KEY);
  check("two IPv4 addresses differ", g(raw("192.0.2.44")) !== g(raw("192.0.2.45")));
  check("a raw and a minimised row of different IPs differ", g(raw("198.51.100.1")) !== g(minimised("198.51.100.2")));
  check("a different key gives a different group for the same IP", networkGroupKeyer(OTHER_KEY)(raw("192.0.2.44")) !== g(raw("192.0.2.44")));
}

console.log("keyer · no key → no grouping");
{
  const g = networkGroupKeyer(null);
  check("raw row → null", g(raw("192.0.2.44")) === null);
  check("minimised row → null (fail closed, even with a stored digest)", g(minimised("192.0.2.44")) === null);
  check("an empty key is no key", networkGroupKeyer({ key: Buffer.alloc(0), version: "v1" })(raw("192.0.2.44")) === null);
}

// ── The reader, end to end on a fake client ──────────────────────────────────

const NOW = new Date("2026-11-04T12:00:00.000Z");
type AuditRow = { h: string; at: Date; ip: string | null; nd: string | null; ndv: string | null; ua: string };
function fakeClient(requests: { id: string; email: string }[], audit: AuditRow[], seen: { values: unknown[][] }) {
  return {
    betaAccessRequest: { findMany: async () => requests.map((r) => ({ ...r, note: null })) },
    betaAccessRequestReview: { findMany: async () => [] },
    user: { findMany: async () => [] },
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join("?");
      if (sql.includes('"AuditLog"')) {
        seen.values.push(values);
        const keyed = values[0] === true;
        // What SQL would return: the raw IP only when the reader asked for it.
        return audit.map((r) => ({ ...r, ip: keyed ? r.ip : null }));
      }
      return [];
    },
  } as unknown as BetaRiskDb;
}
const at = (min: number) => new Date(NOW.getTime() - 60 * 60_000 + min * 60_000);
const req = (i: number) => ({ id: `r${i}`, email: `applicant${i}@example.test` });
const row = (i: number, net: AuditNetworkFields, min = i): AuditRow =>
  ({ h: auditEmailHash(req(i).email), at: at(min), ip: net.ip, nd: net.storedDigest, ndv: net.storedVersion, ua: "browser" });

async function reader(): Promise<void> {
  console.log("reader · SHARED_NETWORK across raw + minimised rows");
  const requests = [0, 1, 2, 3, 4].map(req);
  // r0..r3 share one address — two rows still raw, two already minimised; r4 is elsewhere.
  const audit = [
    row(0, raw("192.0.2.44")),
    row(1, raw("::ffff:192.0.2.44")),
    row(2, minimised("192.0.2.44")),
    row(3, minimised("192.0.2.44")),
    row(4, raw("203.0.113.9")),
  ];
  const seen = { values: [] as unknown[][] };
  const res = await loadBetaRisk(requests.map((r) => r.id), { now: NOW, client: fakeClient(requests, audit, seen), digestKey: KEY });
  const shared = (id: string) => res.byId.get(id)?.reasons.find((r) => r.code === "SHARED_NETWORK");
  check(`r0 shares a network with ${SHARED_NETWORK_MIN_OTHERS} others (2 minimised + 1 raw)`, shared("r0")?.evidence.count === 3, res.byId.get("r0"));
  check("a minimised row is itself grouped with the raw ones", shared("r3")?.evidence.count === 3);
  check("a different IP does not group", shared("r4") === undefined);
  check("the output carries no address or digest",
    !/192\.0\.2|203\.0\.113|[0-9a-f]{64}/.test(JSON.stringify([...res.byId.values()])));
  check("the raw IP is requested only with a key (keyed = true bound)", seen.values[0]?.[0] === true);

  console.log("reader · no key → no grouping signal and a note");
  const seen2 = { values: [] as unknown[][] };
  const off = await loadBetaRisk(requests.map((r) => r.id), { now: NOW, client: fakeClient(requests, audit, seen2), digestKey: null });
  check("no SHARED_NETWORK for anyone", [...off.byId.values()].every((r) => !r.reasons.some((x) => x.code === "SHARED_NETWORK")));
  check("the raw IP is not even selected (keyed = false bound)", seen2.values[0]?.[0] === false);
  check("a note says grouping is off", off.notes.some((n) => /Shared-network grouping is off/.test(n)), off.notes);
}

console.log("census · no md5 over an IP on the beta-risk path");
{
  const stripC = (rel: string) => readFileSync(path.join(process.cwd(), rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const rel of ["lib/platform/growth/beta-risk.ts", "lib/platform/growth/beta-risk-network.ts", "lib/platform/growth/beta-risk-core.ts"]) {
    const src = stripC(rel);
    check(`${rel}: no md5( over ipAddress / ip / net`, !/md5\([^)]*(ipAddress|\bip\b|\bnet\b)/i.test(src));
    // The only createHash("md5") left is the e-mail join key (matches SQL md5(lower(trim("email")))).
    const md5Calls = [...src.matchAll(/createHash\(\s*["']md5["']\s*\)/g)].length;
    check(`${rel}: createHash("md5") only as the e-mail join key`,
      md5Calls === 0 || (rel.endsWith("beta-risk.ts") && md5Calls === 1 && /const emailKey = \(s: string\) => createHash\("md5"\)/.test(src)
        && [...src.matchAll(/\bemailKey\(([^)]*)/g)].every((m) => /^r\.email\b/.test(m[1]))), md5Calls);
    check(`${rel}: no per-read random salt`, !/randomBytes/.test(src));
  }
}

reader().then(() => {
  if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log("\nall checks passed");
}).catch((err) => { console.error(err); process.exit(1); });
