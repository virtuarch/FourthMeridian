/**
 * lib/ai/openai-credentials.test.ts  (OPENAI ENVIRONMENT SEPARATION — Agent C)
 *
 * The credential seam, proven pure over an injected env map — no database, no
 * network, no process.env mutation — plus the SOURCE-SCAN pins:
 *
 *   1. absent key ⇒ throws, and the message carries no value;
 *   2. the project pin is optional, validated, and passed through in full;
 *   3. a malformed pin is refused and its value never appears in the message;
 *   4. the expected-environment guard: unset admits, match admits, mismatch
 *      refuses, an unrecognised value refuses — and the key never appears;
 *   5. the key SHAPE is classified, never echoed;
 *   6. the pure facts module agrees with the seam on every refusal;
 *   7. ONE KEY NAME, NO FALLBACK — a source scan over the committed tree:
 *      only the seam, lib/env.ts's snapshot and tests read OPENAI_API_KEY;
 *      no `||` / `??` joins two credential reads; the provider has exactly one
 *      `new OpenAI(` and passes the seam's `project` explicitly (the SDK would
 *      otherwise read OPENAI_PROJECT_ID itself); nothing in the tree reads the
 *      SDK's other side channels (OPENAI_ORG_ID, OPENAI_BASE_URL).
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/ai/openai-credentials.test.ts
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  OpenAiCredentialsError, refusalFor, resolveOpenAiCredentials,
} from "./openai-credentials";
import {
  classifyOpenAiKey, describeOpenAiConfiguration, OPENAI_PROJECT_ID_PATTERN,
} from "./openai-configuration";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

// Deliberately DISTINCTIVE dummy values so "never appears in a message" is a real assertion.
const KEY = "sk-proj-DUMMY-NEVER-REAL-9f8e7d6c5b4a";
const LEGACY_KEY = "sk-LEGACY-DUMMY-NEVER-REAL-1a2b3c";
const PROJECT = "proj_DummyNeverReal01";
const BAD_PROJECT = "sk-proj-THIS-LOOKS-LIKE-A-KEY-PASTED-IN-THE-WRONG-FIELD";
const BAD_ENV = "prodcution";

function thrown(fn: () => unknown): Error | null {
  try { fn(); return null; } catch (e) { return e as Error; }
}
const carriesNoValue = (msg: string) =>
  !msg.includes(KEY) && !msg.includes(LEGACY_KEY) && !msg.includes(BAD_PROJECT) && !msg.includes(BAD_ENV);

console.log("1. absent key");
{
  const err = thrown(() => resolveOpenAiCredentials({}, "development"));
  check("throws OpenAiCredentialsError", err instanceof OpenAiCredentialsError);
  check("names the variable", !!err && err.message.includes("OPENAI_API_KEY"));
  check("empty string is absent too", thrown(() => resolveOpenAiCredentials({ OPENAI_API_KEY: "" }, "development")) instanceof OpenAiCredentialsError);
}

console.log("2. project pin optional and passed through");
{
  const unpinned = resolveOpenAiCredentials({ OPENAI_API_KEY: KEY }, "development");
  check("apiKey returned as given", unpinned.apiKey === KEY);
  check("project null when unset", unpinned.project === null);
  check("blank pin is unpinned", resolveOpenAiCredentials({ OPENAI_API_KEY: KEY, OPENAI_PROJECT_ID: "   " }, "development").project === null);
  const pinned = resolveOpenAiCredentials({ OPENAI_API_KEY: KEY, OPENAI_PROJECT_ID: ` ${PROJECT} ` }, "development");
  check("pin returned trimmed, in full", pinned.project === PROJECT);
  check("project key + pin ⇒ both present (SDK sends key AND OpenAI-Project header)", pinned.apiKey === KEY && pinned.project === PROJECT && pinned.keyKind === "project");
}

console.log("3. malformed pin refused, value never shown");
{
  // ("proj_" alone is refused too, but the refusal's format hint legitimately
  // contains that prefix, so the never-echoed assertion uses values with a tail.)
  for (const bad of [BAD_PROJECT, "proj_!", "proj_with-dash", "proj_with_underscore", "PROJ_abc", "abc"]) {
    const err = thrown(() => resolveOpenAiCredentials({ OPENAI_API_KEY: KEY, OPENAI_PROJECT_ID: bad }, "development"));
    check(`refuses ${JSON.stringify(bad).slice(0, 24)}…`, err instanceof OpenAiCredentialsError && err.message.includes("OPENAI_PROJECT_ID"));
    check("  …without the value or the key", !!err && carriesNoValue(err.message) && !err.message.includes(bad));
  }
  check("pattern accepts letters and digits only", OPENAI_PROJECT_ID_PATTERN.test("proj_Ab12") && !OPENAI_PROJECT_ID_PATTERN.test("proj_Ab-12"));
}

console.log("4. expected-environment guard");
{
  const base = { OPENAI_API_KEY: KEY, OPENAI_PROJECT_ID: PROJECT };
  check("unset ⇒ admitted on any environment",
    resolveOpenAiCredentials(base, "production").project === PROJECT && resolveOpenAiCredentials(base, "preview").project === PROJECT);
  for (const e of ["development", "preview", "production"] as const) {
    check(`${e} = ${e} ⇒ admitted`, resolveOpenAiCredentials({ ...base, OPENAI_EXPECTED_ENVIRONMENT: e }, e).apiKey === KEY);
  }
  const mismatch = thrown(() => resolveOpenAiCredentials({ ...base, OPENAI_EXPECTED_ENVIRONMENT: "preview" }, "production"));
  check("preview record on a production deployment ⇒ refused", mismatch instanceof OpenAiCredentialsError);
  check("  …names both environment words", !!mismatch && mismatch.message.includes('"preview"') && mismatch.message.includes('"production"'));
  check("  …and never the key or the project id's neighbours", !!mismatch && carriesNoValue(mismatch.message));
  const reverse = thrown(() => resolveOpenAiCredentials({ ...base, OPENAI_EXPECTED_ENVIRONMENT: "production" }, "preview"));
  check("production record on a preview deployment ⇒ refused", reverse instanceof OpenAiCredentialsError);
  const invalid = thrown(() => resolveOpenAiCredentials({ ...base, OPENAI_EXPECTED_ENVIRONMENT: BAD_ENV }, "production"));
  check("unrecognised guard value ⇒ refused", invalid instanceof OpenAiCredentialsError && invalid.message.includes("OPENAI_EXPECTED_ENVIRONMENT"));
  check("  …value not shown", !!invalid && !invalid.message.includes(BAD_ENV));
  check("case matters (Production ≠ production)", thrown(() => resolveOpenAiCredentials({ ...base, OPENAI_EXPECTED_ENVIRONMENT: "Production" }, "production")) instanceof OpenAiCredentialsError);
  check("guard refuses BEFORE the key is consulted (mismatch with no key still says the guard)",
    (thrown(() => resolveOpenAiCredentials({ OPENAI_EXPECTED_ENVIRONMENT: "preview" }, "production"))?.message ?? "").includes("OPENAI_EXPECTED_ENVIRONMENT"));
}

console.log("5. key shape classified, never echoed");
{
  check("sk-proj- ⇒ project", classifyOpenAiKey(KEY) === "project");
  check("sk- ⇒ legacy", classifyOpenAiKey(LEGACY_KEY) === "legacy");
  check("other ⇒ unknown", classifyOpenAiKey("not-a-key") === "unknown" && classifyOpenAiKey(undefined) === "unknown");
  const legacy = resolveOpenAiCredentials({ OPENAI_API_KEY: LEGACY_KEY }, "development");
  check("legacy key admitted unpinned (keyKind legacy)", legacy.keyKind === "legacy" && legacy.project === null);
  const facts = describeOpenAiConfiguration({ OPENAI_API_KEY: KEY, OPENAI_PROJECT_ID: BAD_PROJECT, OPENAI_EXPECTED_ENVIRONMENT: BAD_ENV }, "preview");
  const serialised = JSON.stringify(facts);
  check("facts carry no key and no unvalidated value", !serialised.includes(KEY) && !serialised.includes(BAD_PROJECT) && !serialised.includes(BAD_ENV));
  check("facts: misconfigured pin has projectId null", facts.projectPin.state === "misconfigured" && facts.projectPin.projectId === null);
  check("facts: invalid guard has expected null", facts.expectedEnvironment.state === "invalid" && facts.expectedEnvironment.expected === null);
}

console.log("6. facts and seam agree on refusal");
{
  const cases: [Record<string, string>, "development" | "preview" | "production"][] = [
    [{ OPENAI_API_KEY: KEY }, "development"],
    [{ OPENAI_API_KEY: KEY, OPENAI_PROJECT_ID: PROJECT }, "preview"],
    [{ OPENAI_API_KEY: KEY, OPENAI_PROJECT_ID: BAD_PROJECT }, "preview"],
    [{ OPENAI_API_KEY: KEY, OPENAI_EXPECTED_ENVIRONMENT: "preview" }, "preview"],
    [{ OPENAI_API_KEY: KEY, OPENAI_EXPECTED_ENVIRONMENT: "preview" }, "production"],
    [{ OPENAI_API_KEY: KEY, OPENAI_EXPECTED_ENVIRONMENT: BAD_ENV }, "production"],
  ];
  for (const [env, actual] of cases) {
    const facts = describeOpenAiConfiguration(env, actual);
    const refused = thrown(() => resolveOpenAiCredentials(env, actual)) !== null;
    check(`${Object.keys(env).join("+")} @ ${actual}: refused=${facts.refused}`, facts.refused === refused && (refusalFor(facts) !== null) === facts.refused);
  }
}

console.log("7. ONE KEY NAME, NO FALLBACK — source scan");
{
  const ROOT = process.cwd();
  const seamPath = "lib/ai/openai-credentials.ts";
  const factsPath = "lib/ai/openai-configuration.ts";
  const seam = readFileSync(path.join(ROOT, seamPath), "utf8");
  const facts = readFileSync(path.join(ROOT, factsPath), "utf8");
  const provider = readFileSync(path.join(ROOT, "lib/ai/provider.ts"), "utf8");
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  // The tree as CI will see it: tracked PLUS untracked-but-not-ignored files, so a
  // new reader is caught before it is committed (ignored tmp/, prototype/, .next/ never count).
  const tracked = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "--", "*.ts", "*.tsx", "*.mts", "*.cts", "*.js", "*.mjs", "*.cjs"], { cwd: ROOT, encoding: "utf8" })
    .split("\n").filter((f) => f && !f.startsWith("tmp/") && !f.startsWith("prototype/") && !f.startsWith("node_modules/"));
  check("tracked source listed", tracked.length > 100, `${tracked.length} files`);

  const readsKey = (src: string) => /process\.env(?:\.OPENAI_API_KEY|\[\s*['"]OPENAI_API_KEY['"]\s*\])/.test(strip(src));
  const isTest = (f: string) => /\.test\.tsx?$/.test(f) || f.startsWith("scripts/ai-baseline/");
  const readers = tracked.filter((f) => readsKey(readFileSync(path.join(ROOT, f), "utf8")));
  const unexpected = readers.filter((f) => f !== "lib/env.ts" && !isTest(f));
  check("only lib/env.ts's snapshot and tests/harness read process.env.OPENAI_API_KEY", unexpected.length === 0, unexpected.join(", "));
  check("the seam itself reads the env MAP it was given, not process.env by name", !readsKey(seam) && !readsKey(facts));
  check("the seam touches process.env exactly once — the injectable default", (strip(seam).match(/process\.env/g) ?? []).length === 1);
  check("the facts module never touches process.env", !strip(facts).includes("process.env"));
  check("the facts module has no imports", !/^\s*import\s/m.test(strip(facts)));
  // scripts/ai-baseline/*.check.ts may only TEST PRESENCE (`if (!process.env.OPENAI_API_KEY)`), never read the value into anything.
  for (const f of readers.filter((x) => x.startsWith("scripts/ai-baseline/") && !/\.test\.ts$/.test(x))) {
    const s = strip(readFileSync(path.join(ROOT, f), "utf8"));
    const uses = s.match(/process\.env\.OPENAI_API_KEY/g) ?? [];
    const presenceOnly = (s.match(/!process\.env\.OPENAI_API_KEY\b/g) ?? []).length === uses.length;
    check(`${f}: presence test only`, presenceOnly);
  }

  // No fallback: no `||` / `??` joining two env reads anywhere a credential is resolved.
  const fallback = /process\.env\.\w+\s*(\|\||\?\?)\s*process\.env\.\w+/;
  check("seam: no `||`/`??` between env reads", !fallback.test(strip(seam)));
  check("provider: no `||`/`??` between env reads", !fallback.test(strip(provider)));
  const altNames = tracked.filter((f) => /process\.env\.OPENAI_(?!API_KEY\b|PROJECT_ID\b|EXPECTED_ENVIRONMENT\b)\w+/.test(strip(readFileSync(path.join(ROOT, f), "utf8"))));
  check("no tracked file reads any other OPENAI_* variable (no OPENAI_ORG_ID / OPENAI_BASE_URL / suffixed keys)", altNames.length === 0, altNames.join(", "));

  // The provider builds ONE client from the seam and passes the pin EXPLICITLY —
  // otherwise the SDK's own `project = readEnv('OPENAI_PROJECT_ID')` default decides.
  const providerCode = strip(provider);
  check("provider: exactly one `new OpenAI(`", (providerCode.match(/new OpenAI\(/g) ?? []).length === 1);
  check("provider: client built from resolveOpenAiCredentials()", providerCode.includes("resolveOpenAiCredentials()"));
  check("provider: passes apiKey and project from the seam", /apiKey:\s*creds\.apiKey/.test(providerCode) && /project:\s*creds\.project/.test(providerCode));
  check("provider: never reads the key itself", !readsKey(provider) && !providerCode.includes("OPENAI_API_KEY"));
  const otherClients = tracked.filter((f) => f !== "lib/ai/provider.ts" && !isTest(f) && /new OpenAI\(/.test(strip(readFileSync(path.join(ROOT, f), "utf8"))));
  check("no other file constructs an OpenAI client", otherClients.length === 0, otherClients.join(", "));

  // lib/env.ts mirrors the two companions for the report and introduces no second key name.
  const envTs = strip(readFileSync(path.join(ROOT, "lib/env.ts"), "utf8"));
  check("lib/env.ts snapshots OPENAI_PROJECT_ID and OPENAI_EXPECTED_ENVIRONMENT", envTs.includes("process.env.OPENAI_PROJECT_ID") && envTs.includes("process.env.OPENAI_EXPECTED_ENVIRONMENT"));
  check("lib/env.ts reads no other OPENAI_* name", (envTs.match(/process\.env\.OPENAI_\w+/g) ?? []).every((m) => ["process.env.OPENAI_API_KEY", "process.env.OPENAI_PROJECT_ID", "process.env.OPENAI_EXPECTED_ENVIRONMENT"].includes(m)));
}

console.log(failures === 0 ? "\nAll openai-credentials tests passed." : `\n${failures} failure(s).`);
process.exit(failures === 0 ? 0 : 1);
