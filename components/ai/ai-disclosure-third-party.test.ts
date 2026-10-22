/**
 * components/ai/ai-disclosure-third-party.test.ts — PRIV-011: the point-of-use
 * AI disclosure states, in one plain sentence, that conversation and Daily
 * Brief inputs are processed by OpenAI, a third party.
 *
 * Renders the REAL component to static markup (react-dom/server), the same
 * technique components/ai/ai.test.ts uses.
 *
 *     npx tsx components/ai/ai-disclosure-third-party.test.ts
 */

import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AiDisclosure, AI_DISCLOSURE_ABOUT, AI_DISCLOSURE_LINE, AI_THIRD_PARTY_LINE } from "@/components/ai/AiDisclosure";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

console.log("AI disclosure — third-party processing (PRIV-011)");
const html = renderToStaticMarkup(h(AiDisclosure));
const text = html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&apos;/g, "'").replace(/\s+/g, " ");

check("one sentence (ends with a single full stop, no semicolons)",
  (AI_THIRD_PARTY_LINE.match(/\./g) ?? []).length === 1 && AI_THIRD_PARTY_LINE.endsWith(".") && !AI_THIRD_PARTY_LINE.includes(";"));
check("names OpenAI", /OpenAI/.test(AI_THIRD_PARTY_LINE));
check("calls it a third party", /third-party|third party/i.test(AI_THIRD_PARTY_LINE));
check("covers what you type in a conversation", /type in a conversation/i.test(AI_THIRD_PARTY_LINE));
check("covers the Daily Brief inputs", /Daily Brief/.test(AI_THIRD_PARTY_LINE));
check("says the data is sent for processing (leaves the service)", /sent to OpenAI .* for processing/i.test(AI_THIRD_PARTY_LINE));
check("the sentence is part of the About copy", AI_DISCLOSURE_ABOUT.includes(AI_THIRD_PARTY_LINE));
check("the collapsed line itself names OpenAI at the point of use", /OpenAI/.test(AI_DISCLOSURE_LINE));
// The panel is closed in static markup (open=false), so the full sentence is
// asserted on the panel copy above; the COLLAPSED line is what every render shows.
check("the rendered (collapsed) component names OpenAI at the point of use",
  text.includes("Processed by OpenAI") && text.includes("About"), text.slice(0, 300));
check("existing pin shape preserved: the second segment of the line is still the advice disclaimer",
  AI_DISCLOSURE_LINE.split(" · ")[1] === "Not professional financial advice");

if (failures > 0) { console.error(`\nai-disclosure third-party: ${failures} check(s) failed.`); process.exit(1); }
console.log("\nai-disclosure third-party: all checks passed.");
