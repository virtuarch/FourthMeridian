/**
 * lib/platform/intelligence/ai/compose/causal.ts  (Platform AI P8 — the inferred-cause contract, UNMARKED_CAUSAL)
 *
 * Design v2 §9; MVP PA-1 item 2: "Likely:" only for a HYPOTHESIS; never claim a cause as confirmed unless
 * it is CONFIRMED. The incidents pack gives the model, per incident record, `causeStatus`
 * (CONFIRMED | HYPOTHESIS | NONE) and `cause` (a lib/platform/incidents/codes.ts CAUSE_CODES key), and tells
 * it: state a cause as fact ONLY when causeStatus is CONFIRMED (placing the incident {{r:h|ref}} in that
 * sentence); otherwise write it inside {{inferred}}…{{/inferred}} (rendered "Likely: …").
 *
 * THE DETERMINISTIC CHECK (UNMARKED_CAUSAL). When the incident contract is IN PLAY this turn (an incidents
 * tool answered, an incident record is placed, or the question carries an `[incident h_…]` subject), every
 * sentence of the model's prose OUTSIDE an inferred span that makes a CAUSAL claim — a causal connective
 * ("because", "caused by", "due to", "root cause", …) or a cause-code phrase ("provider outage", …) — is
 * BACKED only when it places an incident record whose causeStatus is CONFIRMED and whose confirmed cause the
 * sentence actually names (the cause code's keywords). Anything else — a HYPOTHESIS cause, no cause, an
 * incident not placed, a different cause than the confirmed one, a model-inferred cause — is MARKED: the
 * sentence is wrapped in the inferred sentinels, so it renders "Likely: …" in the display AND the stored
 * answer. The answer is kept (never replaced); the verdict code UNMARKED_CAUSAL and the count are recorded.
 * A sentence the model already opened with "Likely" is left as written.
 *
 * Known residual (design §16): false positives (a hedged or negated causal sentence is marked "Likely:"
 * too) — the safe direction: a cause is never shown as confirmed unless it is.
 *
 * PURE: no I/O, no clock, no module state. compose/* never imports ../core.
 */

import { INFERRED_CLOSE, INFERRED_OPEN, RECORD_SENTINEL, type RecordSpan } from "./record";

/** The incidents pack's tool names (tools/packs/incidents.ts — pinned equal in its test). */
export const CAUSAL_CONTRACT_TOOLS: readonly string[] = ["incident_overview", "list_incidents", "investigate_incident", "list_incidents_cs", "investigate_incident_cs"];
/** The record kind whose causeStatus / cause back a causal claim. */
export const CAUSAL_RECORD_KIND = "INCIDENT";

/** A causal claim: a connective, or a cause-code phrase. Whole words, case-insensitive. */
const CAUSAL = /\b(?:because|caused|causing|due to|as a result of|result(?:s|ed|ing)? from|stem(?:s|med|ming)? from|root[- ]cause|triggered by|owing to|attributable to|the reason (?:is|was)|provider outage|platform (?:defect|bug)|configuration (?:error|issue|problem)|misconfigur\w*|member input|data defect)\b/i;

/** What a sentence must name to be backed by a CONFIRMED cause of each code. */
export const CAUSE_KEYWORDS: Readonly<Record<string, RegExp>> = {
  PROVIDER_OUTAGE: /\b(?:provider|plaid|outage|unavailable|down|erroring|errors?)\b/i,
  PROVIDER_DATA_DEFECT: /\b(?:provider|plaid)\b[\s\S]*\bdata\b|\bdata defect\b|\b(?:bad|invalid|malformed) data\b/i,
  PLATFORM_DEFECT: /\b(?:platform|defect|bug|our (?:own )?(?:code|processing|system|side))\b/i,
  CONFIGURATION: /\b(?:config(?:uration)?|credentials?|endpoints?|misconfigur\w*)\b/i,
  MEMBER_INPUT: /\b(?:member|customer|user)(?:'s)?\b[\s\S]*\b(?:input|supplied|entered|data)\b|\binvalid input\b/i,
  UNKNOWN: /\b(?:unknown|undetermined|could not be determined|not (?:be )?determined)\b/i,
};

/** Is the incident contract in play this turn? */
export function causalInPlay(input: { traceTools: readonly string[]; spans: readonly Pick<RecordSpan, "rk">[]; question: string }): boolean {
  return input.traceTools.some((t) => CAUSAL_CONTRACT_TOOLS.includes(t))
    || input.spans.some((s) => s.rk === CAUSAL_RECORD_KIND)
    || /\[incident h_[A-Za-z0-9_-]{16}\]/.test(input.question);
}

export const isCausalClaim = (sentence: string): boolean => CAUSAL.test(sentence);

/** A sentence's causal claim is backed by a placed incident whose CONFIRMED cause it names. */
function backed(sentence: string, spans: readonly Pick<RecordSpan, "rk">[], facts: readonly (Readonly<Record<string, unknown>> | null)[]): boolean {
  const prose = sentence.replace(RECORD_SENTINEL, " ");
  for (const m of sentence.matchAll(RECORD_SENTINEL)) {
    const i = m[1].charCodeAt(0) - 97;
    const f = facts[i];
    if (spans[i]?.rk !== CAUSAL_RECORD_KIND || !f || f.causeStatus !== "CONFIRMED" || typeof f.cause !== "string") continue;
    const kw = Object.prototype.hasOwnProperty.call(CAUSE_KEYWORDS, f.cause) ? CAUSE_KEYWORDS[f.cause] : null;
    const literal = new RegExp(`\\b${f.cause.replace(/[^A-Z0-9_]/g, "").replace(/_/g, "[ _]")}\\b`, "i");
    if ((kw && kw.test(prose)) || literal.test(prose)) return true;
  }
  return false;
}

/** Sentence pieces of a text outside inferred spans: split after . ! ? followed by whitespace / end, and at newlines. */
function sentences(chunk: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (const m of chunk.matchAll(/[.!?]+(?=\s|$)|\n/g)) {
    const end = (m.index ?? 0) + m[0].length;
    out.push(chunk.slice(start, end));
    start = end;
  }
  if (start < chunk.length) out.push(chunk.slice(start));
  return out;
}

/**
 * Mark every unbacked causal sentence (outside inferred spans) with the inferred sentinels. `text` is the
 * model's raw prose AFTER markInferred and record extraction (both sentinels present); `spans` / `facts` are
 * the record extraction's (same index). Not in play ⇒ unchanged.
 */
export function markUnbackedCausal(text: string, ctx: { inPlay: boolean; spans: readonly Pick<RecordSpan, "rk">[]; facts: readonly (Readonly<Record<string, unknown>> | null)[] }): { text: string; marked: number } {
  if (!ctx.inPlay || !CAUSAL.test(text)) return { text, marked: 0 };
  let marked = 0;
  let out = "";
  let at = 0;
  // Inferred spans are atomic (already marked); only the prose between them is checked.
  const openAt = (from: number) => text.indexOf(INFERRED_OPEN, from);
  while (at < text.length) {
    const o = openAt(at);
    const end = o < 0 ? text.length : o;
    for (const s of sentences(text.slice(at, end))) {
      const core = s.trim();
      if (core.length === 0 || /^likely\b/i.test(core) || !CAUSAL.test(core) || backed(core, ctx.spans, ctx.facts)) { out += s; continue; }
      const lead = s.slice(0, s.indexOf(core)), tail = s.slice(s.indexOf(core) + core.length);
      out += `${lead}${INFERRED_OPEN}${core}${INFERRED_CLOSE}${tail}`;
      marked++;
    }
    if (o < 0) break;
    const c = text.indexOf(INFERRED_CLOSE, o);
    const stop = c < 0 ? text.length : c + INFERRED_CLOSE.length;
    out += text.slice(o, stop);
    at = stop;
  }
  return { text: out, marked };
}
