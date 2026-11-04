/**
 * lib/privacy/network-minimise.test.ts — the pure IP / UA minimisation.
 * Documentation ranges only (192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24, 2001:db8::/32).
 *   npx tsx lib/privacy/network-minimise.test.ts
 */

import {
  parseIp, canonicalIpStrict, truncateIp, digestIp, minimiseIp, minimiseIpKey, isMinimisedIp,
  userAgentFamily, minimiseUserAgent, NETWORK_ID_DIGEST_LABEL, NETWORK_ID_DIGEST_VERSION, type DigestKey,
} from "@/lib/privacy/network-minimise";
import { canonicalIp, networkDigest } from "@/jobs/data-retention";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const eq = (name: string, got: unknown, want: unknown) => check(name, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const KEY: DigestKey = { key: Buffer.from("k".repeat(40), "utf8"), version: "v1" };
const KEY2: DigestKey = { key: Buffer.from("q".repeat(40), "utf8"), version: "v2" };

console.log("parse / canonical");
eq("IPv4", canonicalIpStrict("192.0.2.17"), "192.0.2.17");
eq("IPv4 trimmed", canonicalIpStrict("  192.0.2.17 \n"), "192.0.2.17");
eq("IPv4 0.0.0.0", canonicalIpStrict("0.0.0.0"), "0.0.0.0");
eq("IPv4 255s", canonicalIpStrict("255.255.255.255"), "255.255.255.255");
eq("IPv6 full upper-case → RFC 5952", canonicalIpStrict("2001:0DB8:0000:0000:0000:0000:0000:0001"), "2001:db8::1");
eq("IPv6 bracketed", canonicalIpStrict("[2001:db8::1]"), "2001:db8::1");
eq("IPv6 zone dropped", canonicalIpStrict("fe80::1%eth0"), "fe80::1");
eq("IPv6 longest zero run compressed", canonicalIpStrict("2001:db8:0:0:1:0:0:0"), "2001:db8:0:0:1::");
eq("IPv6 first run wins a tie", canonicalIpStrict("2001:db8:0:0:1:0:0:1"), "2001:db8::1:0:0:1");
eq("IPv6 single zero group is not compressed", canonicalIpStrict("2001:db8:0:1:1:1:1:1"), "2001:db8:0:1:1:1:1:1");
eq("IPv6 ::", canonicalIpStrict("::"), "::");
eq("IPv6 loopback", canonicalIpStrict("::1"), "::1");
eq("mapped IPv4-in-IPv6 dotted → IPv4", canonicalIpStrict("::ffff:192.0.2.9"), "192.0.2.9");
eq("mapped IPv4-in-IPv6 hex → IPv4", canonicalIpStrict("::ffff:c000:209"), "192.0.2.9");
eq("mapped, fully written", canonicalIpStrict("0:0:0:0:0:FFFF:192.0.2.9"), "192.0.2.9");
check("mapped reports family 4", parseIp("::ffff:192.0.2.9")?.family === 4);
eq("embedded IPv4 in a non-mapped IPv6 stays IPv6", canonicalIpStrict("64:ff9b::192.0.2.9"), "64:ff9b::c000:209");

console.log("invalid input → null");
for (const bad of [
  "", "   ", "unknown", "localhost", "192.0.2", "192.0.2.1.5", "192.0.2.256", "192.0.2.-1", "192.0.2.01",
  "192.0.2.1:8080", "192.0.2.0/24", "2001:db8::1::2", "2001:db8:::1", "2001:db8:1:2:3:4:5:6:7", "2001:db8:1:2:3:4:5",
  "12345::1", "gggg::1", "2001:db8::1.2.3", "::ffff:192.0.2.300", "1.2.3.4::", "2001:db8:1.2.3.4::",
  "1:2:3:4:5:6:7::8", "x".repeat(80),
]) eq(`refuses ${JSON.stringify(bad.length > 30 ? bad.slice(0, 10) + "…" : bad)}`, canonicalIpStrict(bad), null);
for (const bad of [null, undefined, 42, {}, ["192.0.2.1"]]) {
  eq(`non-string ${JSON.stringify(bad)} → null (truncate)`, truncateIp(bad), null);
  eq(`non-string ${JSON.stringify(bad)} → null (digest)`, digestIp(bad, KEY), null);
}

console.log("TRUNCATE: IPv4 /24, IPv6 /48");
eq("IPv4 /24", truncateIp("192.0.2.17"), "192.0.2.0/24");
eq("IPv4 .0 stays", truncateIp("198.51.100.0"), "198.51.100.0/24");
eq("mapped IPv4 truncates as IPv4", truncateIp("::ffff:203.0.113.200"), "203.0.113.0/24");
eq("IPv6 /48", truncateIp("2001:db8:1234:5678:9abc::1"), "2001:db8:1234::/48");
eq("IPv6 /48, zero third group", truncateIp("2001:db8::abcd"), "2001:db8::/48");
eq("IPv6 /48, non-canonical input", truncateIp("2001:0DB8:00AB:FFFF:0:0:0:1"), "2001:db8:ab::/48");
check("truncated IPv4 never echoes the host", !truncateIp("192.0.2.17")!.includes("192.0.2.17"));
check("truncated forms are recognised as minimised", isMinimisedIp(truncateIp("192.0.2.17")!) && isMinimisedIp(truncateIp("2001:db8:1::5")!));
check("a raw address is not recognised as minimised", !isMinimisedIp("192.0.2.17") && !isMinimisedIp("2001:db8::1"));

console.log("DIGEST: keyed, versioned, domain-separated, never unkeyed");
const d = digestIp("192.0.2.17", KEY)!;
check("shape nim1-v1:<32 hex>", new RegExp(`^${NETWORK_ID_DIGEST_VERSION}-v1:[0-9a-f]{32}$`).test(d), d);
check("digest form recognised as minimised", isMinimisedIp(d));
check("never contains the raw address", !d.includes("192.0.2.17"));
eq("deterministic", digestIp("192.0.2.17", KEY), d);
eq("one address, one digest: mapped dotted", digestIp("::ffff:192.0.2.17", KEY), d);
eq("one address, one digest: mapped hex", digestIp("::ffff:c000:211", KEY), d);
eq("one address, one digest: whitespace", digestIp(" 192.0.2.17 ", KEY), d);
eq("IPv6 case / compression insensitive", digestIp("2001:DB8:0:0:0:0:0:1", KEY), digestIp("2001:db8::1", KEY));
check("different addresses differ", digestIp("192.0.2.18", KEY) !== d);
check("different keys differ (and carry their version)", digestIp("192.0.2.17", KEY2)!.startsWith(`${NETWORK_ID_DIGEST_VERSION}-v2:`) && digestIp("192.0.2.17", KEY2)!.slice(8) !== d.slice(8));
eq("no key → null (never an unkeyed hash)", digestIp("192.0.2.17", null), null);
eq("empty key → null", digestIp("192.0.2.17", { key: Buffer.alloc(0), version: "v1" }), null);
eq("invalid → null even with a key", digestIp("unknown", KEY), null);
check("domain-separated from the beta-intake networkDigest under the same key", !networkDigest("192.0.2.17", KEY.key).startsWith(d.split(":")[1]));
check("label is versioned", /:v\d+$/.test(NETWORK_ID_DIGEST_LABEL));
// Reuse proof: for every valid form, the strict canonical agrees with the beta-intake canonicalIp.
for (const s of ["192.0.2.17", "::ffff:192.0.2.17", "::ffff:c000:211", "2001:0DB8::0001", "[2001:db8::1]"]) {
  eq(`canonical agrees with beta-intake canonicalIp: ${s}`, canonicalIpStrict(s), canonicalIp(s));
}

console.log("minimiseIp dispatch");
eq("TRUNCATE", minimiseIp("192.0.2.17", "TRUNCATE"), "192.0.2.0/24");
eq("DIGEST", minimiseIp("192.0.2.17", "DIGEST", KEY), d);
eq("DIGEST without key", minimiseIp("192.0.2.17", "DIGEST"), null);

console.log("IP-bearing keys");
eq("RATE_LIMIT truncate", minimiseIpKey("ip:pre-login:192.0.2.17", "RATE_LIMIT", "TRUNCATE"), "ip:pre-login:192.0.2.0/24");
eq("RATE_LIMIT IPv6", minimiseIpKey("ip:pre-login:2001:db8:aa:bb::1", "RATE_LIMIT", "TRUNCATE"), "ip:pre-login:2001:db8:aa::/48");
eq("RATE_LIMIT digest", minimiseIpKey("ip:pre-login:192.0.2.17", "RATE_LIMIT", "DIGEST", KEY), `ip:pre-login:${d}`);
eq("ANOMALY IPv6 (would mis-split as RATE_LIMIT)", minimiseIpKey("ip:2001:db8::1", "ANOMALY", "TRUNCATE"), "ip:2001:db8::/48");
eq("ANOMALY digest", minimiseIpKey("ip:192.0.2.17", "ANOMALY", "DIGEST", KEY), `ip:${d}`);
eq("not an ip key", minimiseIpKey("user:abc:1", "RATE_LIMIT", "TRUNCATE"), null);
eq("ip key with an unknown address", minimiseIpKey("ip:pre-login:unknown", "RATE_LIMIT", "TRUNCATE"), null);
eq("RATE_LIMIT without a name", minimiseIpKey("ip::192.0.2.1", "RATE_LIMIT", "TRUNCATE"), null);
eq("non-string key", minimiseIpKey(7, "ANOMALY", "TRUNCATE"), null);

console.log("user agent");
const CHROME_MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const SAFARI_IOS = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_1_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1";
const FIREFOX_WIN = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0";
eq("Chrome on macOS (versions dropped)", userAgentFamily(CHROME_MAC), "Chrome on macOS");
eq("Safari on iOS", userAgentFamily(SAFARI_IOS), "Safari on iOS");
eq("Firefox on Windows", userAgentFamily(FIREFOX_WIN), "Firefox on Windows");
eq("script → Unknown device", userAgentFamily("curl/8.4.0"), "Unknown device");
eq("empty → null", userAgentFamily("  "), null);
eq("non-string → null", userAgentFamily(null), null);
eq("NULL method → null", minimiseUserAgent(CHROME_MAC, "NULL"), null);
eq("UA_FAMILY method", minimiseUserAgent(CHROME_MAC, "UA_FAMILY"), "Chrome on macOS");
for (const ua of [CHROME_MAC, SAFARI_IOS, FIREFOX_WIN, "curl/8.4.0", "python-requests/2.31", "X-Custom-Agent 192.0.2.1 token-abc"]) {
  const m = userAgentFamily(ua)!;
  check(`never echoes the raw UA (${ua.slice(0, 20)}…)`, m !== ua && !ua.includes(m) || m === "Unknown device", m);
  check(`family has no version digits (${ua.slice(0, 20)}…)`, !/\d/.test(m), m);
}

if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nall network-minimise checks passed");
