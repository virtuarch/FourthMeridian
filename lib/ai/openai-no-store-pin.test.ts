/**
 * lib/ai/openai-no-store-pin.test.ts — PRIV-OPENAI-NO-STORE (S2 C2 durability pin)
 *
 * INVARIANT: Fourth Meridian never asks OpenAI to store API requests.
 *
 * The Privacy Policy ("Operator tools and AI", content/marketing/privacy.md and
 * site/content/legal/privacy.md) and the AI Disclosures page (legal-ai.md) both
 * say: "We do not ask OpenAI to store these requests." That sentence is true
 * only while every OpenAI call goes through Chat Completions WITHOUT a `store`
 * parameter, and nothing uses the Responses API (which stores by default and
 * chains state via `previous_response_id`).
 *
 * This pin makes the sentence fail CI the moment code drifts from it:
 *
 *   1. NO STORE KEY — no non-test source file that talks to OpenAI (imports the
 *      `openai` SDK or calls `chat.completions.create`) contains a `store` key.
 *      Scoped to those files on purpose: `store:` is a common key elsewhere in
 *      unrelated code.
 *   2. NO RESPONSES API — no non-test source calls `responses.create` /
 *      `.parse` / `.stream`, sends `previous_response_id`, or targets
 *      `/v1/responses`.
 *   3. NOT VACUOUS — lib/ai/provider.ts (the one OpenAI seam) is in the scanned
 *      set, so a refactor cannot silently make rule 1 scan nothing.
 *
 * If this fails because you deliberately need `store: true` or the Responses
 * API: that is a privacy-policy change. Update the wording in BOTH legal pages
 * (and their site/ mirrors) with owner approval in the same PR, then adjust
 * this pin. Do not just delete the assertion.
 *
 * Scope: lib/ app/ scripts/ components/ jobs/ — excluding *.test.* files and
 * eval directories (eval harnesses are not shipped request paths).
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";

const ROOT = process.cwd();
const SCAN_ROOTS = ["lib", "app", "scripts", "components", "jobs"];
const SOURCE_EXT = /\.(ts|tsx|js|mjs|cjs)$/;
const PROVIDER = "lib/ai/provider.ts";

/** Strip comments so prose describing the rule never trips (or satisfies) it. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

function walk(rel: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(path.join(ROOT, rel));
  } catch {
    return;
  }
  for (const name of entries) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const childRel = path.join(rel, name);
    const st = statSync(path.join(ROOT, childRel));
    if (st.isDirectory()) {
      if (/^evals?$/i.test(name)) continue;
      walk(childRel, out);
    } else if (SOURCE_EXT.test(name) && !/\.test\./.test(name)) {
      out.push(childRel.split(path.sep).join("/"));
    }
  }
}

function sources(): { rel: string; code: string }[] {
  const files: string[] = [];
  for (const r of SCAN_ROOTS) walk(r, files);
  return files.map((rel) => ({ rel, code: stripComments(readFileSync(path.join(ROOT, rel), "utf8")) }));
}

const OPENAI_IMPORT = /from\s+['"]openai(?:\/[^'"]*)?['"]|require\(\s*['"]openai['"]\s*\)/;
const CHAT_CREATE = /chat\s*\.\s*completions\s*\.\s*create\b/;
const STORE_KEY = /(?:^|[{,\s])(?:store|['"]store['"])\s*:/m;
const RESPONSES_API = /responses\s*\.\s*(?:create|parse|stream)\b|previous_response_id|\/v1\/responses\b/;

const ALL = sources();
const OPENAI_FILES = ALL.filter((f) => OPENAI_IMPORT.test(f.code) || CHAT_CREATE.test(f.code));

test("3. NOT VACUOUS — the OpenAI seam is in the scanned set", () => {
  assert.ok(
    OPENAI_FILES.some((f) => f.rel === PROVIDER),
    `${PROVIDER} no longer imports openai / calls chat.completions.create — ` +
      `re-point this pin at the new OpenAI seam before removing it.`,
  );
});

test("1. NO STORE KEY — no OpenAI request body sets `store` (privacy: we do not ask OpenAI to store requests)", () => {
  const offenders = OPENAI_FILES.filter((f) => STORE_KEY.test(f.code)).map((f) => f.rel);
  assert.deepEqual(
    offenders,
    [],
    `A \`store\` key appeared in OpenAI-calling source:\n  ${offenders.join("\n  ")}\n` +
      `The Privacy Policy says "We do not ask OpenAI to store these requests." ` +
      `Changing that requires owner-approved policy wording (privacy.md + legal-ai.md, both mirrors).`,
  );
});

test("2. NO RESPONSES API — nothing calls responses.*, previous_response_id or /v1/responses", () => {
  const offenders = ALL.filter((f) => RESPONSES_API.test(f.code)).map((f) => f.rel);
  assert.deepEqual(
    offenders,
    [],
    `Responses API usage found (stores by default):\n  ${offenders.join("\n  ")}\n` +
      `Moving to the Responses API requires owner-approved privacy wording first.`,
  );
});

test("rules match their own violations (self-check)", () => {
  assert.ok(STORE_KEY.test("client.chat.completions.create({ model, store: true })"));
  assert.ok(STORE_KEY.test("const body = {\n  model,\n  store: false,\n};"));
  assert.ok(STORE_KEY.test(`{ "store": true }`));
  assert.ok(!STORE_KEY.test("const datastore: Foo = x; restore: 1"));
  assert.ok(RESPONSES_API.test("await client.responses.create({ model })"));
  assert.ok(RESPONSES_API.test("{ previous_response_id: id }"));
  assert.ok(RESPONSES_API.test("fetch('https://api.openai.com/v1/responses')"));
  assert.ok(!RESPONSES_API.test("const responses = await Promise.all(x)"));
});
