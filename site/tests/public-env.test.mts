/**
 * PROOF 3 — the site reads no arbitrary environment. Exactly one module reads
 * `process.env`, it reads only allowlisted names by literal property access,
 * and none of those names is a secret. There is no other channel: no
 * `process.env[x]`, no destructuring, no passing `process.env` around, no
 * `import.meta.env`, no env file.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { SITE_ROOT, appSourceFiles, parse, rel, visit } from "./_source.mts";

/** The complete public environment authority of the site. */
const PUBLIC_ENV = new Set(["NEXT_PUBLIC_APP_ORIGIN", "NEXT_PUBLIC_SITE_ORIGIN", "NODE_ENV", "VERCEL_ENV"]);
const ENV_READER = "lib/public-config.ts";

function isProcessEnv(n: ts.Node): boolean {
  return ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "process" && n.name.text === "env";
}

interface EnvUse { file: string; line: number; kind: string }

function envUses(): EnvUse[] {
  const uses: EnvUse[] = [];
  for (const file of appSourceFiles()) {
    const sf = parse(file);
    visit(sf, (n) => {
      const line = () => sf.getLineAndCharacterOfPosition(n.getStart()).line + 1;
      if (isProcessEnv(n)) {
        const parent = n.parent;
        if (ts.isPropertyAccessExpression(parent) && parent.expression === n) uses.push({ file: rel(file), line: line(), kind: `name:${parent.name.text}` });
        else uses.push({ file: rel(file), line: line(), kind: "non-literal access to process.env" });
      }
      if (ts.isMetaProperty(n) && ts.isPropertyAccessExpression(n.parent) && n.parent.name.text === "env") {
        uses.push({ file: rel(file), line: line(), kind: "import.meta.env" });
      }
    });
  }
  return uses;
}

test("only lib/public-config.ts reads the environment", () => {
  const outside = envUses().filter((u) => u.file !== ENV_READER);
  assert.deepEqual(outside, []);
});

test("it reads only allowlisted public names, each by literal property access", () => {
  const uses = envUses().filter((u) => u.file === ENV_READER);
  assert.ok(uses.length > 0, "the reader must exist");
  const bad = uses.filter((u) => !u.kind.startsWith("name:") || !PUBLIC_ENV.has(u.kind.slice(5)));
  assert.deepEqual(bad, []);
  assert.deepEqual([...new Set(uses.map((u) => u.kind.slice(5)))].sort(), [...PUBLIC_ENV].sort());
});

test("no allowlisted name is secret-shaped", () => {
  for (const name of PUBLIC_ENV) {
    assert.ok(!/SECRET|KEY|TOKEN|PASSWORD|DATABASE|DSN|PRIVATE/.test(name), name);
  }
});

test("site/ holds no env file except the public template, and the template lists exactly the configurable names", () => {
  const envFiles = readdirSync(SITE_ROOT).filter((f) => f.startsWith(".env"));
  assert.deepEqual(envFiles, [".env.example"]);
  const declared = readFileSync(path.join(SITE_ROOT, ".env.example"), "utf8")
    .split("\n").filter((l) => /^[A-Z_]+=/.test(l)).map((l) => l.split("=")[0]).sort();
  assert.deepEqual(declared, ["NEXT_PUBLIC_APP_ORIGIN", "NEXT_PUBLIC_SITE_ORIGIN"]);
});

test("next.config.ts declares no `env` block (which would inline arbitrary values into the bundle)", () => {
  const sf = parse(path.join(SITE_ROOT, "next.config.ts"));
  const keys: string[] = [];
  visit(sf, (n) => { if (ts.isPropertyAssignment(n) && ts.isIdentifier(n.name)) keys.push(n.name.text); });
  assert.ok(!keys.includes("env"), "next.config.ts must not set `env`");
  assert.ok(keys.includes("output"), "next.config.ts must configure the static export");
});
