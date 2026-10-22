/**
 * lib/security/client-ip.test.ts — ARCH-003 / CQ-004: one IP extractor, one
 * trust model, every consumer on it.
 *
 * PART A — the extractor, executed with spoofed `x-forwarded-for` + platform
 *          header combinations (the runtime reproduction rotated XFF to rotate
 *          the limiter bucket; it must not any more).
 * PART B — source pins: lib/rate-limit.ts, lib/api.ts and lib/auth.ts read the
 *          IP ONLY through this module; no other non-test file reads an IP header.
 *
 *     npx tsx lib/security/client-ip.test.ts
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { CLIENT_IP_HEADER_ORDER, getClientIp, normaliseIpCandidate, UNKNOWN_CLIENT_IP } from "./client-ip";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const H = (h: Record<string, string>) => new Headers(h);
const ip = (h: Record<string, string>, trustCloudflare = false) => getClientIp(H(h), { trustCloudflare });

console.log("client-ip (ARCH-003)\n\nA. trust model");
check("no headers → unknown", ip({}) === UNKNOWN_CLIENT_IP);

// x-forwarded-for: LAST entry, never the client-chosen first one.
check("XFF single entry → that entry", ip({ "x-forwarded-for": "203.0.113.9" }) === "203.0.113.9");
check("XFF chain → LAST entry (the trusted proxy's), not the first (client-chosen)",
  ip({ "x-forwarded-for": "10.1.0.30, 198.51.100.7, 203.0.113.9" }) === "203.0.113.9");
check("spoofed first hop cannot rotate the result when the proxy appends the real one",
  ip({ "x-forwarded-for": "1.1.1.1, 203.0.113.9" }) === ip({ "x-forwarded-for": "2.2.2.2, 203.0.113.9" }));
check("XFF trailing comma / spaces → walks back to the last real entry",
  ip({ "x-forwarded-for": "203.0.113.9, " }) === "203.0.113.9");
check("XFF with a garbage tail → unknown (never 'whatever came before')",
  ip({ "x-forwarded-for": "203.0.113.9, <script>" }) === UNKNOWN_CLIENT_IP);
check("XFF entry with a port → port stripped", ip({ "x-forwarded-for": "203.0.113.9:51234" }) === "203.0.113.9");
check("XFF IPv6 (bracketed with port) → bare address",
  ip({ "x-forwarded-for": "[2001:db8::1]:443" }) === "2001:db8::1" && ip({ "x-forwarded-for": "2001:db8::1" }) === "2001:db8::1");

// Platform headers outrank x-forwarded-for.
check("x-real-ip outranks XFF", ip({ "x-forwarded-for": "10.1.0.30", "x-real-ip": "203.0.113.9" }) === "203.0.113.9");
check("x-vercel-forwarded-for outranks x-real-ip and XFF",
  ip({ "x-forwarded-for": "10.1.0.30", "x-real-ip": "198.51.100.7", "x-vercel-forwarded-for": "203.0.113.9" }) === "203.0.113.9");
check("x-vercel-forwarded-for chain → its FIRST entry (Vercel writes the client there)",
  ip({ "x-vercel-forwarded-for": "203.0.113.9, 10.0.0.1" }) === "203.0.113.9");

// cf-connecting-ip is a client header unless Cloudflare is declared.
check("cf-connecting-ip IGNORED by default (no Cloudflare in front ⇒ client-writable)",
  ip({ "cf-connecting-ip": "203.0.113.50", "x-forwarded-for": "10.1.0.30" }) === "10.1.0.30");
check("cf-connecting-ip alone, default → unknown (not the client's claim)",
  ip({ "cf-connecting-ip": "203.0.113.50" }) === UNKNOWN_CLIENT_IP);
check("cf-connecting-ip FIRST when Cloudflare is declared",
  ip({ "cf-connecting-ip": "203.0.113.50", "x-real-ip": "198.51.100.7", "x-forwarded-for": "10.1.0.30" }, true) === "203.0.113.50");
check("the env default is OFF in this process", process.env.CLIENT_IP_TRUST_CLOUDFLARE === undefined && getClientIp(H({ "cf-connecting-ip": "203.0.113.50" })) === UNKNOWN_CLIENT_IP);

// Garbage never becomes a key.
for (const bad of ["", "   ", "localhost", "203.0.113", "a".repeat(100), "'; DROP TABLE x; --", "203.0.113.9 evil", "1.2.3.4.5"]) {
  check(`garbage ${JSON.stringify(bad).slice(0, 30)} → not an IP`, normaliseIpCandidate(bad) === null);
}
check("the plain-object header form (NextAuth authorize) is read the same way",
  getClientIp({ "x-forwarded-for": "10.1.0.30, 203.0.113.9" }) === "203.0.113.9" &&
  getClientIp({ "X-Real-IP": undefined, "x-real-ip": ["198.51.100.7"] }) === "198.51.100.7");
check("documented order is cf → vercel → real-ip → xff",
  JSON.stringify(CLIENT_IP_HEADER_ORDER) === JSON.stringify(["cf-connecting-ip", "x-vercel-forwarded-for", "x-real-ip", "x-forwarded-for"]));

console.log("\nB. every consumer reads through this module");
const ROOT = process.cwd();
const code = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8").replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
const IP_HEADERS = /["'](x-forwarded-for|x-real-ip|cf-connecting-ip|x-vercel-forwarded-for)["']/;

const rl = code("lib/rate-limit.ts");
check("lib/rate-limit.ts delegates to lib/security/client-ip", rl.includes('from "@/lib/security/client-ip"') && !IP_HEADERS.test(rl));
check("limitByIp / checkIpLimitStrict key on getClientIp(req)", /enforce\(`ip:\$\{name\}:\$\{getClientIp\(req\)\}`/.test(rl) && /checkStrict\(`ip:\$\{name\}:\$\{getClientIp\(req\)\}`/.test(rl));
const api = code("lib/api.ts");
check("lib/api.ts getRequestMeta delegates (no header order of its own)", api.includes('from "@/lib/security/client-ip"') && !IP_HEADERS.test(api));
const auth = code("lib/auth.ts");
check("lib/auth.ts authorize() delegates (no header order of its own)", auth.includes('from "@/lib/security/client-ip"') && !IP_HEADERS.test(auth));

// No other production file reads an IP header.
function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(path.join(ROOT, dir))) {
    const rel = path.join(dir, e);
    if (statSync(path.join(ROOT, rel)).isDirectory()) { if (e !== "node_modules" && e !== ".next") walk(rel, out); }
    else if (/\.tsx?$/.test(e) && !/\.test\.tsx?$/.test(e)) out.push(rel);
  }
  return out;
}
const readers = [...walk("lib"), ...walk("app"), ...walk("jobs"), "proxy.ts"]
  .filter((rel) => rel !== "lib/security/client-ip.ts" && IP_HEADERS.test(code(rel)));
check("lib/security/client-ip.ts is the ONLY production reader of an IP header", readers.length === 0, readers.join(", "));

if (failures > 0) { console.error(`\nclient-ip: ${failures} check(s) failed.`); process.exit(1); }
console.log("\nclient-ip: all checks passed.");
