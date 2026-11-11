/**
 * lib/platform/intelligence/ai/authz/people-vocabulary.ts  (Platform AI — the bare-username guard's PRODUCT VOCABULARY, S2 09fc G3)
 *
 * A customer whose username happens to equal a product word ("connections", "incidents", "growth") must
 * not block an ordinary operator question. The guard (authz/people.ts runPickerGuard) therefore never looks
 * up a token that is product vocabulary. The vocabulary is BUILT FROM THE REGISTRIES, not a hand list:
 *
 *   registry labels   every metric (id, label, domain) — lib/platform/intelligence/metrics/registry.ts (the
 *                     navigation registry is import-pinned; its labels derive from the areas and metrics)
 *   area names        PLATFORM_AREAS (key, label, navLabel, spaceName, section keys / labels) — lib/platform/policy.ts
 *   closed codes      tool names, tool packs, result statuses, tiers, subject id kinds / outcomes,
 *                     boundary denial reasons
 *   router pack terms every ROUTER_RULES keyword rule (engine/router.ts) — a token one of them matches
 *
 * Words are split on anything that is not [a-z0-9_] and case-folded. Server-side (the registries import
 * server packs); built once per process.
 */

import "server-only";

import { PLATFORM_AREAS } from "@/lib/platform/policy";
import { METRICS } from "@/lib/platform/intelligence/metrics/registry";
import { ROUTER_RULES } from "../engine/router";
import { PLATFORM_AI_REGISTERED_TOOLS } from "../tools/registry";
import { TOOL_PACKS, TOOL_RESULT_STATUSES, TOOL_TIERS } from "../tools/contract";
import { BOUNDARY_DENIAL_REASONS } from "./recheck";
import { SUBJECT_ID_KINDS, SUBJECT_OUTCOMES } from "./subject";

/** Every word of a registry string (and the whole string when it is one token, e.g. a tool name). */
function wordsOf(s: string | null | undefined): string[] {
  if (typeof s !== "string" || s.length === 0) return [];
  const lower = s.toLowerCase();
  const out = lower.split(/[^a-z0-9_]+/).filter((w) => w.length > 0);
  // Also the underscore / hyphen parts ("CUSTOMER_SUCCESS" ⇒ customer_success, customer, success).
  for (const w of [...out]) if (w.includes("_")) out.push(...w.split("_").filter((x) => x.length > 0));
  return out;
}

/** The registry-built product vocabulary (case-folded words). */
export function buildProductVocabulary(): ReadonlySet<string> {
  const v = new Set<string>();
  const add = (s: string | null | undefined) => { for (const w of wordsOf(s)) v.add(w); };
  for (const m of METRICS) { add(m.id); add(m.label); add(m.domain); }
  // (The navigation registry is import-pinned to its accessor and guarded routes; its labels derive from these area sections and the metrics.)
  for (const a of Object.values(PLATFORM_AREAS)) { add(a.key); add(a.label); add(a.navLabel); add(a.spaceName); for (const s of a.sections) { add(s.key); add(s.label); } }
  for (const codes of [PLATFORM_AI_REGISTERED_TOOLS, TOOL_PACKS, TOOL_RESULT_STATUSES, TOOL_TIERS, SUBJECT_ID_KINDS, SUBJECT_OUTCOMES, BOUNDARY_DENIAL_REASONS, ROUTER_RULES.map((r) => r.pack)] as readonly (readonly string[])[]) {
    for (const c of codes) add(c);
  }
  return v;
}

let cached: ReadonlySet<string> | null = null;

/** True when `token` (case-folded, one word) is product vocabulary: a registry word or a router pack term. */
export function isProductVocabulary(token: string): boolean {
  const t = token.toLowerCase();
  if (cached === null) cached = buildProductVocabulary();
  if (cached.has(t)) return true;
  // A router keyword rule that matches the token on its own (whole word, case-insensitive; the rules carry no /g).
  return ROUTER_RULES.some((r) => r.match.test(t));
}
