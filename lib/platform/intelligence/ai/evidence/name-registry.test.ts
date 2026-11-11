/**
 * lib/platform/intelligence/ai/evidence/name-registry.test.ts  (Platform AI P5 — name registry, D-3 / S2 ruling 6)
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/platform/intelligence/ai/evidence/name-registry.test.ts
 *
 * 1. every registry name passes the static rule (≤ 40 chars, no digit run ≥ 4, no @ / URL / braces / control chars);
 * 2. STATIC LITERALS (ruling 6): the module imports nothing, and every entry of INSTITUTIONS / WALLET_NETWORKS /
 *    MERCHANTS is `key: "literal"` in the source — no template, call, spread, identifier or computed key —
 *    and the source literals are exactly the runtime values (nothing added at runtime);
 * 3. lookups: listed key ⇒ its name; unlisted / non-string / prototype keys ⇒ the generic word;
 * 4. the rule itself refuses each bad shape.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import * as R from "./name-registry";

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`); }
}

const SRC = readFileSync(path.join(process.cwd(), "lib/platform/intelligence/ai/evidence/name-registry.ts"), "utf8");
const code = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const REGISTRIES = { INSTITUTIONS: R.INSTITUTIONS, WALLET_NETWORKS: R.WALLET_NETWORKS, MERCHANTS: R.MERCHANTS } as const;

console.log("1. the static rule over every name");
const all = [...R.INSTITUTION_NAMES, ...R.WALLET_NETWORK_NAMES, ...R.MERCHANT_NAMES];
const bad = all.map((n) => ({ n, p: R.registryNameProblems(n) })).filter((x) => x.p.length > 0);
check(`${all.length} names (incl. the generic words): none has a problem`, bad.length === 0, bad);

console.log("\n2. static literals only (S2 ruling 6)");
check("the module imports nothing (no DB, no env, no other module)", !/\bimport\b|\brequire\(/.test(code));
for (const [name, rec] of Object.entries(REGISTRIES)) {
  const m = new RegExp(`export const ${name}: Readonly<Record<string, string>> = Object\\.freeze\\(\\{([\\s\\S]*?)\\}\\);`).exec(code);
  check(`${name}: declared as Object.freeze({ … }) of literals`, !!m);
  if (!m) continue;
  const body = m[1].trim();
  const entries = body === "" ? [] : body.split(/,\s*\n/).map((l) => l.trim().replace(/,$/, "")).filter(Boolean);
  const literal = /^([A-Za-z_][A-Za-z0-9_]*|"[A-Za-z0-9_:-]+"): "([^"\\`$]*)"$/;
  const parsed = entries.map((e) => literal.exec(e));
  check(`${name}: every entry is \`key: "literal"\` (no template, call, spread, identifier or computed key)`, parsed.every((p) => p !== null), entries.filter((_, i) => !parsed[i]));
  const fromSource = Object.fromEntries(parsed.filter((p): p is RegExpExecArray => p !== null).map((p) => [p[1].replace(/^"|"$/g, ""), p[2]]));
  check(`${name}: the source literals are exactly the runtime registry`, JSON.stringify(fromSource) === JSON.stringify({ ...rec }));
  check(`${name}: frozen`, Object.isFrozen(rec));
}
check("INSTITUTIONS is keyed by Plaid institution ids (ins_…), never by a display name", Object.keys(R.INSTITUTIONS).every((k) => /^ins_\d+$/.test(k)));
check("WALLET_NETWORKS is keyed by closed chain codes", Object.keys(R.WALLET_NETWORKS).every((k) => /^[A-Z]{2,6}$/.test(k)));

console.log("\n3. lookups");
check("a listed institution id ⇒ its registry name", R.institutionName("ins_129562") === R.INSTITUTIONS.ins_129562 && R.institutionName("ins_129562") !== R.UNLISTED_INSTITUTION);
check("an unlisted / null / non-string / prototype key ⇒ the generic word",
  R.institutionName("ins_0") === R.UNLISTED_INSTITUTION && R.institutionName(null) === R.UNLISTED_INSTITUTION
  && R.institutionName("__proto__") === R.UNLISTED_INSTITUTION && R.institutionName("toString") === R.UNLISTED_INSTITUTION
  && R.walletNetworkName("XYZ") === R.UNLISTED_WALLET_NETWORK && R.merchantName("anything") === R.UNLISTED_MERCHANT);
check("a wallet chain code ⇒ its network", R.walletNetworkName("BTC") === R.WALLET_NETWORKS.BTC && R.walletNetworkName("BTC") !== R.UNLISTED_WALLET_NETWORK);

console.log("\n4. the rule refuses each bad shape");
for (const [label, v] of [["41 chars", "x".repeat(41)], ["digit run", "Bank 12345"], ["@", "a@b"], ["URL", "https://x"], ["www", "www.x.com"],
  ["brace", "{{m:x}}"], ["control", "a\u0007b"], ["empty", ""], ["padded", " Bank"], ["not a string", 42]] as const) {
  check(`refuses ${label}`, R.registryNameProblems(v).length > 0);
}
check("accepts a plain short name", R.registryNameProblems("Example Bank 24").length === 0);

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nall checks passed");
