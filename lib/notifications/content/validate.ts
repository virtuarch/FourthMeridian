/**
 * lib/notifications/content/validate.ts  (Comms Center B1 — the content validator, contract v1.1 §2.2–§2.5)
 *
 * Two steps, both pure:
 *   parseContentBody  — is the request a ContentBody AT ALL (types and shape)?
 *                       No ⇒ 400 VALIDATION (the route), nothing else is said.
 *   validateContent   — every rule of §2.2 / §2.3 / §2.5 over a parsed body,
 *                       returning ALL issues at once, each typed and located
 *                       per block (Session 2 shape 2). Any `error` ⇒ 400
 *                       CONTENT_INVALID and nothing is written; warnings are
 *                       returned on the saved version.
 *
 * Messages never echo content beyond a placeholder name.
 */

import type { ContentBlock, ContentBody, ContentIssue, ContentIssueCode, ContentLocation, EditableChannel } from "./types";
import { LIMITS, type LegSpec, type PlaceholderSpec } from "./legs";
import { added, adviceHits, claimHits, figureTokens, hasPiiLike, linkHits, softLinkHits } from "./lint";

/** Bump when a rule tightens: stored versions are re-validated on read and before publish. */
export const VALIDATOR_VERSION = 1;

const NAME = /^[a-z][A-Za-z0-9]{0,31}$/;
const TOKEN = /\{\{([a-z][A-Za-z0-9]{0,31})\}\}/g;
/** C0/C1 controls, Unicode line/paragraph separators and bidi controls (escape.ts cleanText's class). */
const CONTROLS_SINGLE = /[\u0000-\u001F\u007F-\u009F\u2028\u2029\u202A-\u202E\u2066-\u2069]/;
/** Multi-line fields (paragraph text) may carry "\n" only. */
const CONTROLS_MULTI = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F\u2028\u2029\u202A-\u202E\u2066-\u2069]/;

// ── 1. Shape ─────────────────────────────────────────────────────────────────

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === "string";

function onlyKeys(o: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(o).every((k) => allowed.includes(k));
}

/** A ContentBody, by shape only (no rule is judged here). */
export function parseContentBody(raw: unknown): Parsed<ContentBody> {
  if (!isObj(raw) || !onlyKeys(raw, ["subject", "preheader", "blocks"])) return { ok: false, error: "content must be { subject, preheader, blocks }." };
  if (!str(raw.subject)) return { ok: false, error: "content.subject must be a string." };
  if (raw.preheader !== null && !str(raw.preheader)) return { ok: false, error: "content.preheader must be a string or null." };
  if (!Array.isArray(raw.blocks) || raw.blocks.length > 50) return { ok: false, error: "content.blocks must be an array." };
  const blocks: ContentBlock[] = [];
  for (const b of raw.blocks) {
    if (!isObj(b) || !str(b.kind)) return { ok: false, error: "every block needs a kind." };
    switch (b.kind) {
      case "hero":
        if (!onlyKeys(b, ["kind", "heading", "greeting"]) || !str(b.heading) || (b.greeting !== undefined && !str(b.greeting))) return { ok: false, error: "hero is { heading, greeting? }." };
        blocks.push({ kind: "hero", heading: b.heading, ...(b.greeting !== undefined ? { greeting: b.greeting as string } : {}) });
        break;
      case "paragraph":
        if (!onlyKeys(b, ["kind", "text"]) || !str(b.text)) return { ok: false, error: "paragraph is { text }." };
        blocks.push({ kind: "paragraph", text: b.text });
        break;
      case "cta":
        if (!onlyKeys(b, ["kind", "label", "link"]) || !str(b.label) || !str(b.link)) return { ok: false, error: "cta is { label, link }." };
        blocks.push({ kind: "cta", label: b.label, link: b.link });
        break;
      case "info":
        if (!onlyKeys(b, ["kind", "title", "items", "ordered"]) || !Array.isArray(b.items) || b.items.length > 50 || !b.items.every(str)
          || (b.title !== undefined && !str(b.title)) || (b.ordered !== undefined && typeof b.ordered !== "boolean")) return { ok: false, error: "info is { title?, items, ordered? }." };
        blocks.push({ kind: "info", items: [...(b.items as string[])], ...(b.title !== undefined ? { title: b.title as string } : {}), ...(b.ordered !== undefined ? { ordered: b.ordered as boolean } : {}) });
        break;
      case "divider":
        if (!onlyKeys(b, ["kind"])) return { ok: false, error: "divider has no fields." };
        blocks.push({ kind: "divider" });
        break;
      default:
        // An unknown kind is a typed rule issue, not a shape error — but it carries no
        // fields we can trust, so it is kept as a placeholder the validator reports.
        blocks.push({ kind: b.kind as "divider" });
    }
  }
  return { ok: true, value: { subject: raw.subject, preheader: (raw.preheader as string | null), blocks } };
}

// ── 2. Fields ────────────────────────────────────────────────────────────────

/** One text field of a body, with where it is and what it may contain. */
export interface ContentField {
  location: ContentLocation;
  /** The §2.3 location class for placeholder `allowedIn`. */
  where: "subject" | "preheader" | "body" | "cta";
  value: string;
  multiLine: boolean;
  max: number;
  required: boolean;
}

export function fieldsOf(body: ContentBody, channel: EditableChannel): ContentField[] {
  const L = LIMITS[channel];
  const out: ContentField[] = [{ location: { field: "subject" }, where: "subject", value: body.subject, multiLine: false, max: L.subject, required: true }];
  if (body.preheader !== null) out.push({ location: { field: "preheader" }, where: "preheader", value: body.preheader, multiLine: false, max: L.preheader ?? 140, required: true });
  body.blocks.forEach((b, blockIndex) => {
    const at = (prop: Extract<ContentLocation, { field: "block" }>["prop"], itemIndex?: number): ContentLocation =>
      ({ field: "block", blockIndex, prop, ...(itemIndex !== undefined ? { itemIndex } : {}) });
    switch (b.kind) {
      case "hero":
        out.push({ location: at("heading"), where: "body", value: b.heading, multiLine: false, max: L.heading, required: true });
        if (b.greeting !== undefined) out.push({ location: at("greeting"), where: "body", value: b.greeting, multiLine: false, max: L.heading, required: true });
        break;
      case "paragraph":
        out.push({ location: at("text"), where: "body", value: b.text, multiLine: true, max: L.paragraph, required: true });
        break;
      case "cta":
        out.push({ location: at("label"), where: "cta", value: b.label, multiLine: false, max: L.ctaLabel, required: true });
        break;
      case "info":
        if (b.title !== undefined) out.push({ location: at("title"), where: "body", value: b.title, multiLine: false, max: L.infoTitle, required: true });
        b.items.forEach((item, i) => out.push({ location: at("items", i), where: "body", value: item, multiLine: false, max: L.infoItem, required: true }));
        break;
      default:
        break;
    }
  });
  return out;
}

/** The {{names}} of one string, in order, and whether any brace is left over (malformed). */
export function tokensOf(s: string): { names: string[]; malformed: boolean } {
  const names = [...s.matchAll(TOKEN)].map((m) => m[1]);
  const rest = s.replace(TOKEN, "");
  return { names, malformed: rest.includes("{{") || rest.includes("}}") };
}

/** Distinct placeholder names, first-use order (text fields, then cta links in block order). */
export function placeholdersUsed(body: ContentBody, channel: EditableChannel): string[] {
  const seen: string[] = [];
  const add = (n: string) => { if (!seen.includes(n)) seen.push(n); };
  for (const f of fieldsOf(body, channel)) for (const n of tokensOf(f.value).names) add(n);
  for (const b of body.blocks) if (b.kind === "cta" && NAME.test(b.link)) add(b.link);
  return seen;
}

// ── 3. Rules ─────────────────────────────────────────────────────────────────

export interface ValidateOptions {
  /** "manual": financial / advice are warnings. "ai": every issue is an error. */
  mode: "manual" | "ai";
  /** The text the financial / advice lexicons compare against (code default for manual drafts). */
  baseline: ContentBody;
  variant: string;
}

const issue = (code: ContentIssueCode, severity: ContentIssue["severity"], location: ContentLocation | null, message: string, placeholder?: string): ContentIssue =>
  ({ code, severity, location, message, ...(placeholder ? { placeholder } : {}) });

const ALLOWED_KINDS: Record<EditableChannel, ReadonlySet<string>> = {
  EMAIL: new Set(["hero", "paragraph", "cta", "info", "divider"]),
  IN_APP: new Set(["paragraph", "cta"]),
};

/** Every issue of a parsed body against its leg (all at once). */
export function validateContent(spec: LegSpec, body: ContentBody, opts: ValidateOptions): ContentIssue[] {
  const issues: ContentIssue[] = [];
  const ch = spec.channel;
  const L = LIMITS[ch];
  const byName = new Map<string, PlaceholderSpec>(spec.placeholders.map((p) => [p.name, p]));
  const soft: ContentIssue["severity"] = opts.mode === "manual" ? "warning" : "error";

  // Structure.
  if (ch === "IN_APP" && body.preheader !== null) issues.push(issue("BLOCK_KIND_NOT_ALLOWED", "error", { field: "preheader" }, "In-app notifications have no preheader."));
  if (ch === "EMAIL" && body.preheader === null) issues.push(issue("EMPTY_FIELD", "error", { field: "preheader" }, "An email needs a preheader."));
  if (body.blocks.length < L.blocksMin) issues.push(issue("EMPTY_CONTENT", "error", null, "An email needs at least one block."));
  if (body.blocks.length > L.blocks) issues.push(issue("TOO_MANY_BLOCKS", "error", null, `At most ${L.blocks} blocks.`));
  const counts = new Map<string, number>();
  body.blocks.forEach((b, blockIndex) => {
    counts.set(b.kind, (counts.get(b.kind) ?? 0) + 1);
    if (!ALLOWED_KINDS[ch].has(b.kind)) {
      issues.push(issue("BLOCK_KIND_NOT_ALLOWED", "error", { field: "block", blockIndex, prop: "text" }, `A "${String(b.kind).slice(0, 20)}" block is not allowed here.`));
      return;
    }
    if (b.kind === "hero" && blockIndex !== 0) issues.push(issue("BLOCK_ORDER", "error", { field: "block", blockIndex, prop: "heading" }, "The heading block must come first."));
    if ((b.kind === "hero" || b.kind === "cta" || (ch === "IN_APP" && b.kind === "paragraph")) && (counts.get(b.kind) ?? 0) > 1) {
      issues.push(issue("TOO_MANY_BLOCKS", "error", { field: "block", blockIndex, prop: b.kind === "hero" ? "heading" : b.kind === "cta" ? "label" : "text" }, `At most one ${b.kind} block.`));
    }
    if (b.kind === "info" && b.items.length > L.infoItems) issues.push(issue("TOO_MANY_ITEMS", "error", { field: "block", blockIndex, prop: "items" }, `At most ${L.infoItems} items.`));
    if (b.kind === "info" && b.items.length === 0) issues.push(issue("EMPTY_FIELD", "error", { field: "block", blockIndex, prop: "items" }, "A list needs at least one item."));
    if (b.kind === "cta") {
      const loc: ContentLocation = { field: "block", blockIndex, prop: "link" };
      const p = byName.get(b.link);
      if (!NAME.test(b.link) || !p) issues.push(issue("UNKNOWN_PLACEHOLDER", "error", loc, "The button must link to one of this template's link placeholders.", NAME.test(b.link) ? b.link : undefined));
      else if (p.kind !== "LINK") issues.push(issue("PLACEHOLDER_KIND_MISMATCH", "error", loc, `{{${p.name}}} is text, not a link.`, p.name));
    }
  });

  // Text fields: length, controls, placeholders, lint.
  const baselineText = fieldsOf(opts.baseline, ch).map((f) => f.value).join("\n");
  for (const f of fieldsOf(body, ch)) {
    if (f.required && f.value.trim() === "") issues.push(issue("EMPTY_FIELD", "error", f.location, "This field is empty."));
    if (f.value.length > f.max) issues.push(issue("FIELD_TOO_LONG", "error", f.location, `At most ${f.max} characters.`));
    if ((f.multiLine ? CONTROLS_MULTI : CONTROLS_SINGLE).test(f.value)) issues.push(issue("CONTROL_CHARACTERS", "error", f.location, "Control characters, line breaks here, and direction overrides are not allowed."));
    const t = tokensOf(f.value);
    if (t.malformed) issues.push(issue("MALFORMED_PLACEHOLDER", "error", f.location, "Placeholders are written {{name}}; a stray brace was found."));
    for (const n of new Set(t.names)) {
      const p = byName.get(n);
      if (!p) issues.push(issue("UNKNOWN_PLACEHOLDER", "error", f.location, `{{${n}}} is not a placeholder of this template.`, n));
      else if (p.kind === "LINK") issues.push(issue("PLACEHOLDER_KIND_MISMATCH", "error", f.location, `{{${n}}} is a link; use it as the button's link.`, n));
      else if (!p.allowedIn.includes(f.where)) issues.push(issue("PLACEHOLDER_NOT_ALLOWED_HERE", "error", f.location, `{{${n}}} cannot be used here.`, n));
    }
    if (linkHits(f.value).length > 0) issues.push(issue("LINK_NOT_ALLOWED", "error", f.location, "Links, domains, email addresses and phone numbers cannot be typed into the text."));
    else if (added(softLinkHits(f.value), softLinkHits(baselineText)).length > 0) issues.push(issue("LINK_NOT_ALLOWED", soft, f.location, "This looks like a web or IP address (perhaps a missing space after a full stop)."));
    if (hasPiiLike(f.value)) issues.push(issue("PII_LIKE_CONTENT", "error", f.location, "Long digit runs, addresses and credential words are not allowed."));
    const newFigures = added(figureTokens(f.value), figureTokens(baselineText));
    const newClaims = added(claimHits(f.value), claimHits(baselineText));
    if (newFigures.length > 0 || newClaims.length > 0) issues.push(issue("FINANCIAL_CLAIM", soft, f.location, "Numbers, amounts, rates or financial claims that the original copy did not make."));
    if (added(adviceHits(f.value), adviceHits(baselineText)).length > 0) issues.push(issue("ADVICE_LANGUAGE", soft, f.location, "Financial, legal or tax advice, or legal language."));
  }

  // Required placeholders (§2.3).
  for (const p of spec.placeholders) {
    if (p.requiredIn?.includes("subject") && !tokensOf(body.subject).names.includes(p.name)) {
      issues.push(issue("REQUIRED_PLACEHOLDER_MISSING", "error", { field: "subject" }, `The subject must name {{${p.name}}}.`, p.name));
    }
  }
  const link = spec.requiredLink(opts.variant);
  if (link !== null) {
    const ctas = body.blocks.filter((b): b is Extract<ContentBlock, { kind: "cta" }> => b.kind === "cta");
    if (ctas.length !== 1 || ctas[0].link !== link) issues.push(issue("REQUIRED_PLACEHOLDER_MISSING", "error", null, `This email must keep exactly one button linking to {{${link}}}.`, link));
  }
  return issues;
}

export const hasErrors = (issues: readonly ContentIssue[]) => issues.some((i) => i.severity === "error");
export const warningsOf = (issues: readonly ContentIssue[]) => issues.filter((i) => i.severity === "warning");
