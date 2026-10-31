/**
 * lib/notifications/content/ai.ts  (Comms Center B1 — AI-assisted authoring, contract v1.1 §4)
 *
 * "Polish with Fourth Meridian AI". The operator saves a draft; this module asks
 * the model for a rewrite (POLISH) or minimal fixes (CHECK) of THAT version and
 * returns a SUGGESTION — a separate CommsAiSuggestion row. It never writes a
 * version, never touches the base, and has no path to publish, roll back or send.
 * The operator accepts by saving a NEW draft from it (store.ts saveDraft, source
 * AI_SUGGESTION). Manual editing never reads anything here.
 *
 * DATA MINIMISATION (§4.2, pinned by ai.test.ts against the exact payload):
 * the request carries ONLY the fixed instruction text, the base version's
 * subject / preheader / block texts, its block kinds and order, the placeholder
 * NAMES, and the mode and tone. Never a placeholder value, sample or fallback;
 * never recipient, customer, Space, account, delivery or ledger data; never the
 * operator's identity, the reason note or any other version.
 *
 * OUTPUT IS UNTRUSTED (§4.4): deterministic checks against the base — structure,
 * the multiset of placeholders per field, no added link / domain / email /
 * phone, no added figure or claim, no added advice or legal language, and every
 * §2.5 rule — and ANY failure rejects the suggestion (422; the text is never
 * returned and never stored). Unvalidated text is never returned as clean.
 *
 * AVAILABILITY (§4.5), checked in order BEFORE any model call; the first failure
 * answers 503 AI_UNAVAILABLE with a typed reason:
 *   1 KILL_SWITCH  readPaidRequestsAdmission (kill switch / maintenance; fail closed)
 *   2 COST_FREEZE  readGlobalCostFreeze — the GLOBAL flag only (ON ⇒ FROZEN;
 *                  INVALID / UNAVAILABLE ⇒ UNVERIFIED; OFF / MISSING ⇒ not
 *                  blocked). A Beta-GROUP-only freeze is a customer restriction
 *                  and is NOT read here (D1).
 *   3 ALLOWANCE    the authoring allowance (ai-allowance.ts), fail closed
 *   4 PROVIDER     the call failed (timeout, refusal, empty / unparseable output,
 *                  unpriced model, quota, rate limit) — no provider text returned
 */

import type { ChatMessage } from "@/lib/ai/provider";
import { cleanText } from "@/lib/email/design/escape";
import type { ContentBlock, ContentBody, ContentIssue, ContentLocation, AiSuggestMode, AiTone, AiSuggestResult } from "./types";
import type { LegSpec } from "./legs";
import { fieldsOf, tokensOf, validateContent } from "./validate";
import { added, adviceHits, claimHits, figureTokens, linkHits, softLinkHits } from "./lint";

export const SUGGESTION_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_NOTES = 10;

// ── 1. The request (§4.2) ────────────────────────────────────────────────────

export const AI_SYSTEM_PROMPT = [
  "You edit the copy of one transactional notification for Fourth Meridian, a personal finance app.",
  "You receive the current copy as JSON and return the edited copy in the same JSON shape.",
  "Rules you must follow exactly:",
  "1. Keep every placeholder written as {{name}} exactly as written, the same number of times, in the same field. Never add, remove, rename or translate a placeholder.",
  "2. Keep the same blocks: the same number, the same kinds, the same order, the same number of list items. Never change a button's link field.",
  "3. Do not add links, web addresses, domains, email addresses or phone numbers.",
  "4. Do not add numbers, amounts, currencies, percentages, rates, returns or any financial claim.",
  "5. Do not give or imply financial, investment, legal or tax advice. Do not promise or guarantee anything. Do not add legal language.",
  "6. Plain text only: no HTML, no Markdown, no emoji.",
  "7. Keep the meaning. Keep it short and clear. Fields that do not apply to a block are null.",
  "Mode POLISH: rewrite for clarity and the requested tone. Mode CHECK: fix only grammar, spelling and tone; change as little as possible.",
  "In notes, list what you changed and why (at most 10, one short sentence each, no links).",
].join("\n");

/** The base content as the model sees it: texts, kinds and order only. */
function wireContent(base: ContentBody) {
  return {
    subject: base.subject,
    preheader: base.preheader,
    blocks: base.blocks.map((b) => ({
      kind: b.kind,
      heading: b.kind === "hero" ? b.heading : null,
      greeting: b.kind === "hero" ? b.greeting ?? null : null,
      text: b.kind === "paragraph" ? b.text : null,
      label: b.kind === "cta" ? b.label : null,
      link: b.kind === "cta" ? b.link : null,
      title: b.kind === "info" ? b.title ?? null : null,
      items: b.kind === "info" ? [...b.items] : null,
    })),
  };
}

/** The exact request: system prompt + ONE user message. Pure; pinned by ai.test.ts. */
export function buildAiRequest(base: ContentBody, placeholderNames: readonly string[], mode: AiSuggestMode, tone: AiTone): { system: string; messages: ChatMessage[] } {
  const payload = { mode, tone: mode === "POLISH" ? tone : null, placeholders: placeholderNames.map((n) => `{{${n}}}`), content: wireContent(base) };
  return { system: AI_SYSTEM_PROMPT, messages: [{ role: "user", content: JSON.stringify(payload) }] };
}

const nullable = (t: string) => ({ type: [t, "null"] });

/** The strict JSON schema (every property required; non-applicable fields null). */
export const AI_RESPONSE_SCHEMA: { name: string; schema: Record<string, unknown> } = {
  name: "comms_content_suggestion",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["subject", "preheader", "blocks", "notes"],
    properties: {
      subject: { type: "string" },
      preheader: nullable("string"),
      blocks: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["kind", "heading", "greeting", "text", "label", "link", "title", "items"],
          properties: {
            kind: { type: "string", enum: ["hero", "paragraph", "cta", "info", "divider"] },
            heading: nullable("string"), greeting: nullable("string"), text: nullable("string"),
            label: nullable("string"), link: nullable("string"), title: nullable("string"),
            items: { type: ["array", "null"], items: { type: "string" } },
          },
        },
      },
      notes: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["blockIndex", "field", "category", "text"],
          properties: {
            blockIndex: { type: ["integer", "null"] },
            field: { type: ["string", "null"], enum: ["subject", "preheader", "heading", "greeting", "text", "label", "title", "items", null] },
            category: { type: "string", enum: ["GRAMMAR", "SPELLING", "TONE", "CLARITY", "CONSISTENCY"] },
            text: { type: "string" },
          },
        },
      },
    },
  },
};

// ── 2. The checks (§4.4) ─────────────────────────────────────────────────────

const err = (code: ContentIssue["code"], location: ContentLocation | null, message: string, placeholder?: string): ContentIssue =>
  ({ code, severity: "error", location, message, ...(placeholder ? { placeholder } : {}) });

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Map the model's flat blocks back onto the base's structure. Any mismatch is STRUCTURE_CHANGED. */
export function normaliseSuggestion(raw: unknown, base: ContentBody): { ok: true; body: ContentBody; rawNotes: unknown[] } | { ok: false; issues: ContentIssue[] } {
  const structure = (location: ContentLocation | null, why: string) => ({ ok: false as const, issues: [err("STRUCTURE_CHANGED", location, why)] });
  if (!isObj(raw) || typeof raw.subject !== "string" || !Array.isArray(raw.blocks)) return structure(null, "The suggestion did not match the expected shape.");
  if ((base.preheader === null) !== (raw.preheader === null) || (raw.preheader !== null && typeof raw.preheader !== "string")) return structure({ field: "preheader" }, "The suggestion changed the preheader's presence.");
  if (raw.blocks.length !== base.blocks.length) return structure(null, "The suggestion changed the number of blocks.");
  const blocks: ContentBlock[] = [];
  for (let i = 0; i < base.blocks.length; i++) {
    const b = base.blocks[i];
    const o = raw.blocks[i];
    const at = (prop: Extract<ContentLocation, { field: "block" }>["prop"]): ContentLocation => ({ field: "block", blockIndex: i, prop });
    if (!isObj(o) || o.kind !== b.kind) return structure(at("text"), "The suggestion changed a block's kind or order.");
    const s = (k: string) => (typeof o[k] === "string" ? (o[k] as string) : null);
    switch (b.kind) {
      case "hero": {
        const heading = s("heading");
        const greeting = s("greeting");
        if (heading === null || (b.greeting !== undefined) !== (greeting !== null)) return structure(at("heading"), "The suggestion changed the heading block.");
        blocks.push({ kind: "hero", heading, ...(greeting !== null ? { greeting } : {}) });
        break;
      }
      case "paragraph": {
        const text = s("text");
        if (text === null) return structure(at("text"), "The suggestion dropped a paragraph.");
        blocks.push({ kind: "paragraph", text });
        break;
      }
      case "cta": {
        const label = s("label");
        if (label === null || o.link !== b.link) return structure(at("link"), "The suggestion changed the button or its link.");
        blocks.push({ kind: "cta", label, link: b.link });
        break;
      }
      case "info": {
        const title = s("title");
        const items = Array.isArray(o.items) && o.items.every((x) => typeof x === "string") ? (o.items as string[]) : null;
        if (items === null || items.length !== b.items.length || (b.title !== undefined) !== (title !== null)) return structure(at("items"), "The suggestion changed a list's items.");
        blocks.push({ kind: "info", items, ...(title !== null ? { title } : {}), ...(b.ordered !== undefined ? { ordered: b.ordered } : {}) });
        break;
      }
      case "divider":
        blocks.push({ kind: "divider" });
        break;
    }
  }
  return { ok: true, body: { subject: raw.subject, preheader: (raw.preheader as string | null), blocks }, rawNotes: Array.isArray(raw.notes) ? raw.notes : [] };
}

/** Multiset difference of names: what `a` has more of than `b`. */
function multisetMinus(a: readonly string[], b: readonly string[]): string[] {
  const left = [...b];
  const out: string[] = [];
  for (const x of a) {
    const i = left.indexOf(x);
    if (i >= 0) left.splice(i, 1);
    else out.push(x);
  }
  return out;
}

/** Every §4.4 check of a normalised suggestion against its base. Empty ⇒ clean. */
export function checkSuggestion(spec: LegSpec, variant: string, base: ContentBody, suggestion: ContentBody): ContentIssue[] {
  const issues: ContentIssue[] = [];
  const bf = fieldsOf(base, spec.channel);
  const sf = fieldsOf(suggestion, spec.channel);
  for (let i = 0; i < sf.length; i++) {
    const before = bf[i]?.value ?? "";
    const after = sf[i].value;
    const loc = sf[i].location;
    const bn = tokensOf(before).names;
    const an = tokensOf(after).names;
    for (const n of new Set(multisetMinus(bn, an))) issues.push(err("PLACEHOLDERS_DROPPED", loc, `The suggestion lost {{${n}}}.`, n));
    for (const n of new Set(multisetMinus(an, bn))) issues.push(err("PLACEHOLDERS_ADDED", loc, `The suggestion added {{${n}}}.`, n));
    if (added([...linkHits(after), ...softLinkHits(after)], [...linkHits(before), ...softLinkHits(before)]).length > 0) issues.push(err("LINK_NOT_ALLOWED", loc, "The suggestion added a link, domain, email address or phone number."));
    if (added(figureTokens(after), figureTokens(before)).length > 0 || added(claimHits(after), claimHits(before)).length > 0) {
      issues.push(err("FINANCIAL_CLAIM", loc, "The suggestion added a figure or a financial claim."));
    }
    if (added(adviceHits(after), adviceHits(before)).length > 0) issues.push(err("ADVICE_LANGUAGE", loc, "The suggestion added advice or legal language."));
  }
  // Every §2.5 rule, all as errors (AI mode), relative to the base for the lexicons.
  issues.push(...validateContent(spec, suggestion, { mode: "ai", baseline: base, variant }).map((x) => ({ ...x, severity: "error" as const })));
  // One issue per (code, location).
  const seen = new Set<string>();
  return issues.filter((x) => {
    const k = `${x.code}|${JSON.stringify(x.location)}|${x.placeholder ?? ""}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Field-by-field changes, in document order (the side-by-side diff). Structure is identical by now. */
export function diffContent(spec: LegSpec, base: ContentBody, suggestion: ContentBody): AiSuggestResult["changes"] {
  const bf = fieldsOf(base, spec.channel);
  const sf = fieldsOf(suggestion, spec.channel);
  return sf.flatMap((f, i) => (bf[i] && bf[i].value !== f.value ? [{ location: f.location, before: bf[i].value, after: f.value }] : []));
}

const NOTE_CATEGORIES = new Set(["GRAMMAR", "SPELLING", "TONE", "CLARITY", "CONSISTENCY"]);
const BLOCK_PROPS = new Set(["heading", "greeting", "text", "label", "title", "items"]);

/** Display-only notes: cleaned, capped, dropped (not rejected) when they trip the link lexicon. */
export function cleanNotes(raw: readonly unknown[], base: ContentBody): AiSuggestResult["notes"] {
  const out: AiSuggestResult["notes"] = [];
  for (const n of raw) {
    if (out.length >= MAX_NOTES || !isObj(n) || typeof n.text !== "string" || !NOTE_CATEGORIES.has(String(n.category))) continue;
    const text = cleanText(n.text, 200);
    if (!text || linkHits(text).length > 0) continue;
    let location: ContentLocation | null = null;
    if (n.field === "subject" || n.field === "preheader") location = { field: n.field };
    else if (typeof n.blockIndex === "number" && Number.isInteger(n.blockIndex) && n.blockIndex >= 0 && n.blockIndex < base.blocks.length && BLOCK_PROPS.has(String(n.field))) {
      location = { field: "block", blockIndex: n.blockIndex, prop: n.field as Extract<ContentLocation, { field: "block" }>["prop"] };
    }
    out.push({ location, category: n.category as AiSuggestResult["notes"][number]["category"], text });
  }
  return out;
}
