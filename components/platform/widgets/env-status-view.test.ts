/**
 * components/platform/widgets/env-status-view.test.ts  (OPENAI ENVIRONMENT SEPARATION)
 *
 * The pure view-model behind the "OpenAI project pin" block: every state maps to
 * a word and a tone, the pinned id is shown IN FULL (a non-secret identifier),
 * and nothing that is not in the facts can appear — in particular no key.
 *
 *   npx tsx components/platform/widgets/env-status-view.test.ts
 */

import type { OpenAiConfigurationFacts } from "@/lib/ai/openai-configuration";
import { openAiBlockTone, openAiFactLines } from "./env-status-view";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const facts = (over: Partial<OpenAiConfigurationFacts> & { pin?: OpenAiConfigurationFacts["projectPin"]; guard?: OpenAiConfigurationFacts["expectedEnvironment"] }): OpenAiConfigurationFacts => ({
  keyConfigured: true,
  keyKind: "project",
  projectPin: over.pin ?? { state: "pinned", projectId: "proj_ViewFixture42" },
  expectedEnvironment: over.guard ?? { state: "match", expected: "preview", actual: "preview" },
  refused: false,
  ...over,
});

console.log("1. the healthy picture");
{
  const lines = openAiFactLines(facts({}));
  check("three lines, in order", lines.map((l) => l.label).join(" · ") === "OpenAI key · Project pin · Environment guard");
  check("key: project key, ok", lines[0].value === "project key" && lines[0].tone === "ok");
  check("pin shown in full", lines[1].value.includes("proj_ViewFixture42") && lines[1].tone === "ok");
  check("guard: match · preview", lines[2].value === "match · preview" && lines[2].tone === "ok");
  check("block tone ok", openAiBlockTone(facts({})) === "ok");
}

console.log("2. degraded states are warn, refusals are bad");
{
  check("key unset ⇒ warn + 'not set'", openAiFactLines(facts({ keyConfigured: false, keyKind: "unknown" }))[0].tone === "warn");
  check("legacy key ⇒ warn", openAiFactLines(facts({ keyKind: "legacy" }))[0].tone === "warn");
  check("unpinned ⇒ warn", openAiFactLines(facts({ pin: { state: "unpinned", projectId: null } }))[1].tone === "warn");
  check("misconfigured pin ⇒ bad, says refused", (() => { const l = openAiFactLines(facts({ pin: { state: "misconfigured", projectId: null } }))[1]; return l.tone === "bad" && /refused/.test(l.value); })());
  check("guard unset ⇒ warn", openAiFactLines(facts({ guard: { state: "unset", expected: null, actual: "production" } }))[2].tone === "warn");
  const mm = openAiFactLines(facts({ guard: { state: "mismatch", expected: "preview", actual: "production" } }))[2];
  check("guard mismatch ⇒ bad, names both words", mm.tone === "bad" && mm.value.includes("preview") && mm.value.includes("production"));
  check("guard invalid ⇒ bad", openAiFactLines(facts({ guard: { state: "invalid", expected: null, actual: "production" } }))[2].tone === "bad");
  check("block tone: worst wins (bad over ok)", openAiBlockTone(facts({ pin: { state: "misconfigured", projectId: null } })) === "bad");
  check("block tone: warn when only degraded", openAiBlockTone(facts({ pin: { state: "unpinned", projectId: null } })) === "warn");
}

console.log("3. nothing but the facts reaches the screen");
{
  const all = JSON.stringify(openAiFactLines(facts({ pin: { state: "misconfigured", projectId: null }, guard: { state: "invalid", expected: null, actual: "preview" } })));
  // The misconfigured line may say "not a proj_ id" (the format hint); an id-SHAPED token may not appear.
  check("no key prefix and no id-shaped token when nothing validated", !all.includes("sk-") && !/proj_[A-Za-z0-9]+/.test(all));
}

console.log(failures === 0 ? "\nAll env-status-view tests passed." : `\n${failures} failure(s).`);
process.exit(failures === 0 ? 0 : 1);
