/**
 * components/platform/comms/content-model.ts  (Customer Success — Communications Center › content editor, pure)
 *
 * Words and shapes for the catalog drawer's content editor (contract v1.1
 * §1.1, §2.2–§2.6, §3, §4). No React, no fetch, no clock.
 *
 *   fields      every editable text field of a body, keyed by its ContentLocation
 *   issues      server issues → the field / block / template slot they belong to,
 *               and the Save / Publish gate (errors block; warnings need an ack)
 *   placeholders the {{name}} picker (filtered by the focused field's `allowedIn`)
 *               and token insertion at the cursor; a CTA link is a LINK name only
 *   structure   which blocks may be added / removed / moved (the §2.2 rules for a
 *               MANUAL draft; STRUCTURE_CHANGED is an AI-only rule, §2.5)
 *   controls    every control from the server's `viewer` block and the leg lock
 *   drafts      the unsaved draft; a 409 CONFLICT keeps it, never discards it
 *   diffs       field-by-field before/after rows (AI changes, version vs live)
 *   AI          the unavailable reasons in plain English
 *
 * The server is the authority on every rule: these helpers only decide what is
 * RENDERED and what the operator is told. Imports types and value lists from the
 * client-safe vocabularies only.
 */

import type { CommsChannel } from "@/lib/notifications/catalog/types";
import type {
  AiAvailability, AiSuggestResult, CatalogContentLeg, AiUnavailableReason, ContentBlock, ContentBlockKind, ContentBody, ContentIssue, ContentLocation,
  EditableChannel, LiveContent, PlaceholderLocation, PlaceholderView, TemplateVersionDTO, VersionCreatedByKind, VersionState, VersionsResponse, Viewer,
} from "@/lib/notifications/content/types";
import type { CommsReadResult } from "@/lib/platform/comms-center/client";
import type { StatusTone } from "../platform-surface";

const n = (v: number) => v.toLocaleString("en-US");

// ── Limits the `limits` block does not carry (contract §2.2, fixed) ──────────────

/**
 * §2.2 contract values for the per-block limits — the FALLBACK only, for a server
 * older than v1.1.1 that does not send them in `limits`. The server's numbers
 * always win (`blockLimits`).
 */
export const FIXED_LIMITS = { heading: 120, greeting: 120, infoTitle: 120, infoItem: 200, infoItems: 8 } as const;

export type BlockLimits = { -readonly [K in keyof typeof FIXED_LIMITS]: number };

/**
 * The per-block limits the editor enforces: the server's (`limits.heading` …,
 * v1.1.1) when present as a number, else the contract fallback. A server `null`
 * means that block kind is not allowed on the channel — such a block can't be
 * added there, so the fallback number only ever labels a stray one.
 */
export function blockLimits(limits: Limits): BlockLimits {
  const pick = (v: number | null | undefined, fallback: number) => (typeof v === "number" ? v : fallback);
  return {
    heading: pick(limits.heading, FIXED_LIMITS.heading),
    greeting: pick(limits.greeting, FIXED_LIMITS.greeting),
    infoTitle: pick(limits.infoTitle, FIXED_LIMITS.infoTitle),
    infoItem: pick(limits.infoItem, FIXED_LIMITS.infoItem),
    infoItems: pick(limits.infoItems, FIXED_LIMITS.infoItems),
  };
}
/** §2.2 block-count floor: an email needs one block, an in-app message none. */
export const MIN_BLOCKS: Record<EditableChannel, number> = { EMAIL: 1, IN_APP: 0 };
/** §2.2 allowed kinds per channel, in the order the "Add block" menu offers them. */
export const BLOCK_KINDS: Record<EditableChannel, readonly ContentBlockKind[]> = { EMAIL: ["hero", "paragraph", "cta", "info", "divider"], IN_APP: ["paragraph", "cta"] };
export const BLOCK_LABEL: Record<ContentBlockKind, string> = { hero: "Heading", paragraph: "Paragraph", cta: "Button", info: "List", divider: "Divider" };
export const CHANNEL_WORD: Record<EditableChannel, string> = { EMAIL: "Email", IN_APP: "In-app" };

/** §3.8 render bucket is 30/min per operator: one live check per settled edit, never faster than this. */
export const RENDER_DEBOUNCE_MS = 2500;

export type Limits = VersionsResponse["limits"];

// ── Legs (§1, §2.1) ─────────────────────────────────────────────────────────────

export interface LegOption {
  channel: EditableChannel;
  variants: string[];
  /** False ⇒ the leg is locked; the versions read says why (PROTECTED / NOT_EDITABLE). */
  editable: boolean;
  /** "Published v3" / "Code default" for a variant. */
  liveOf: (variant: string) => string;
}

/**
 * Every email / in-app leg of a definition: the editable ones from `content`
 * (variants + what is live), the others as locked (one "default" stream) so the
 * operator sees WHY they can't edit it rather than a missing channel.
 */
export function legOptions(d: { channels: ReadonlyArray<{ channel: CommsChannel }>; content?: readonly CatalogContentLeg[] }): LegOption[] {
  const out: LegOption[] = [];
  for (const ch of ["EMAIL", "IN_APP"] as const) {
    const leg = d.content?.find((c) => c.channel === ch);
    if (leg && leg.variants.length > 0) {
      out.push({ channel: ch, variants: [...leg.variants], editable: true, liveOf: (variant) => {
        const l = leg.live.find((x) => x.variant === variant);
        return l && l.source === "PUBLISHED" ? `Published v${l.version}` : "Code default";
      } });
    } else if (d.channels.some((c) => c.channel === ch)) {
      out.push({ channel: ch, variants: ["default"], editable: false, liveOf: () => "Code default" });
    }
  }
  return out;
}

/** The lock of a definition with NO email / in-app leg at all (banner / operator only), without a read. */
export function lockedLegReason(d: { protected: boolean }): "PROTECTED" | "NOT_EDITABLE" {
  return d.protected ? "PROTECTED" : "NOT_EDITABLE";
}

// ── Fields ──────────────────────────────────────────────────────────────────────

export type BlockProp = Extract<ContentLocation, { field: "block" }>["prop"];

export interface EditorField {
  key: string;
  location: ContentLocation;
  /** The §2.3 class `allowedIn` is judged against. */
  where: PlaceholderLocation;
  label: string;
  value: string;
  max: number;
  multiLine: boolean;
}

/** One stable key per location: "subject", "preheader", "b2.text", "b3.items.1". */
export function fieldKey(loc: ContentLocation): string {
  if (loc.field !== "block") return loc.field;
  return `b${loc.blockIndex}.${loc.prop}${loc.itemIndex !== undefined ? `.${loc.itemIndex}` : ""}`;
}

const PROP_LABEL: Record<BlockProp, string> = { heading: "heading", greeting: "greeting", text: "text", label: "label", link: "link", title: "title", items: "items" };

/** "Subject", "Block 2 · Paragraph text", "Block 3 · List item 2". `body` names the block kind when known. */
export function locationLabel(loc: ContentLocation | null, body?: ContentBody | null): string {
  if (loc === null) return "Whole message";
  if (loc.field === "subject") return "Subject";
  if (loc.field === "preheader") return "Preheader";
  const kind = body?.blocks[loc.blockIndex]?.kind;
  const what = kind ? `${BLOCK_LABEL[kind]} ` : "";
  const prop = loc.prop === "items" && loc.itemIndex !== undefined ? `item ${loc.itemIndex + 1}` : PROP_LABEL[loc.prop];
  const tail = `${what}${prop}`;
  return `Block ${loc.blockIndex + 1} · ${tail.charAt(0).toUpperCase()}${tail.slice(1)}`;
}

/** Every text field the editor renders, in document order (the CTA `link` is a select, not text). */
export function editorFields(body: ContentBody, channel: EditableChannel, limits: Limits, subjectLabel?: string): EditorField[] {
  const B = blockLimits(limits);
  const out: EditorField[] = [{ key: "subject", location: { field: "subject" }, where: "subject", label: subjectLabel ?? (channel === "EMAIL" ? "Subject" : "Title"), value: body.subject, max: limits.subject, multiLine: false }];
  if (channel === "EMAIL" && body.preheader !== null) {
    out.push({ key: "preheader", location: { field: "preheader" }, where: "preheader", label: "Preheader", value: body.preheader, max: limits.preheader ?? 140, multiLine: false });
  }
  body.blocks.forEach((b, blockIndex) => {
    const at = (prop: BlockProp, itemIndex?: number): ContentLocation => ({ field: "block", blockIndex, prop, ...(itemIndex !== undefined ? { itemIndex } : {}) });
    const push = (loc: ContentLocation, where: PlaceholderLocation, label: string, value: string, max: number, multiLine = false) =>
      out.push({ key: fieldKey(loc), location: loc, where, label, value, max, multiLine });
    switch (b.kind) {
      case "hero":
        push(at("heading"), "body", "Heading", b.heading, B.heading);
        if (b.greeting !== undefined) push(at("greeting"), "body", "Greeting", b.greeting, B.greeting);
        break;
      case "paragraph": push(at("text"), "body", "Text", b.text, limits.paragraph, true); break;
      case "cta": push(at("label"), "cta", "Button label", b.label, limits.ctaLabel); break;
      case "info":
        if (b.title !== undefined) push(at("title"), "body", "List title", b.title, B.infoTitle);
        b.items.forEach((item, i) => push(at("items", i), "body", `Item ${i + 1}`, item, B.infoItem));
        break;
      default: break;
    }
  });
  return out;
}

/** Write one field (immutable). An out-of-range location returns the body unchanged. */
export function setField(body: ContentBody, loc: ContentLocation, value: string): ContentBody {
  if (loc.field === "subject") return { ...body, subject: value };
  if (loc.field === "preheader") return body.preheader === null ? body : { ...body, preheader: value };
  const b = body.blocks[loc.blockIndex];
  if (!b) return body;
  let next: ContentBlock = b;
  if (b.kind === "hero" && (loc.prop === "heading" || loc.prop === "greeting")) next = { ...b, [loc.prop]: value };
  else if (b.kind === "paragraph" && loc.prop === "text") next = { ...b, text: value };
  else if (b.kind === "cta" && (loc.prop === "label" || loc.prop === "link")) next = { ...b, [loc.prop]: value };
  else if (b.kind === "info" && loc.prop === "title") next = { ...b, title: value };
  else if (b.kind === "info" && loc.prop === "items" && loc.itemIndex !== undefined && loc.itemIndex < b.items.length) next = { ...b, items: b.items.map((x, i) => (i === loc.itemIndex ? value : x)) };
  if (next === b) return body;
  return { ...body, blocks: body.blocks.map((x, i) => (i === loc.blockIndex ? next : x)) };
}

/** "12 / 120"; `over` when the server would refuse FIELD_TOO_LONG. */
export function charCount(value: string, max: number): { text: string; over: boolean; near: boolean } {
  return { text: `${n(value.length)} / ${n(max)}`, over: value.length > max, near: value.length > max * 0.9 && value.length <= max };
}

// ── Issues → where they show ────────────────────────────────────────────────────

export interface PlacedIssues {
  /** Template-level (location null) and anything whose location no longer exists. */
  top: ContentIssue[];
  /** By fieldKey, for fields the editor renders (incl. "b{i}.link" for the CTA select). */
  field: Record<string, ContentIssue[]>;
  /** By block index: block-level issues with no rendered field (kind, order, count, a list's items). */
  block: Record<number, ContentIssue[]>;
}

const push = <K extends string | number>(m: Record<K, ContentIssue[]>, k: K, i: ContentIssue) => { (m[k] ??= []).push(i); };

/** Place each issue at its `location` in THIS body (§2.5). Pure; errors first within a slot. */
export function placeIssues(issues: readonly ContentIssue[], body: ContentBody, channel: EditableChannel, limits: Limits): PlacedIssues {
  const keys = new Set(editorFields(body, channel, limits).map((f) => f.key));
  body.blocks.forEach((b, i) => { if (b.kind === "cta") keys.add(`b${i}.link`); });
  const out: PlacedIssues = { top: [], field: {}, block: {} };
  for (const i of issues) {
    const loc = i.location;
    if (loc === null) { out.top.push(i); continue; }
    const k = fieldKey(loc);
    if (keys.has(k)) { push(out.field, k, i); continue; }
    if (loc.field === "block" && loc.blockIndex >= 0 && loc.blockIndex < body.blocks.length) { push(out.block, loc.blockIndex, i); continue; }
    out.top.push(i);
  }
  const bySeverity = (a: ContentIssue, b: ContentIssue) => (a.severity === b.severity ? 0 : a.severity === "error" ? -1 : 1);
  out.top.sort(bySeverity);
  for (const k of Object.keys(out.field)) out.field[k].sort(bySeverity);
  for (const k of Object.keys(out.block)) out.block[Number(k)].sort(bySeverity);
  return out;
}

export interface IssueGate { errors: number; warnings: number; blocks: boolean; needsAck: boolean; summary: string }

/** Errors block Save and Publish; warnings need an explicit acknowledgement at publish (§2.5, §3.4). */
export function issueGate(issues: readonly ContentIssue[]): IssueGate {
  const errors = issues.filter((i) => i.severity === "error").length;
  const warnings = issues.length - errors;
  const parts: string[] = [];
  if (errors) parts.push(`${n(errors)} error${errors === 1 ? "" : "s"}`);
  if (warnings) parts.push(`${n(warnings)} warning${warnings === 1 ? "" : "s"}`);
  return { errors, warnings, blocks: errors > 0, needsAck: warnings > 0, summary: parts.length ? parts.join(" · ") : "No issues" };
}

// ── Placeholders (§2.3) ─────────────────────────────────────────────────────────

/** TEXT placeholders the focused field may contain (LINK names are only ever a button's link). */
export function insertablePlaceholders(all: readonly PlaceholderView[], where: PlaceholderLocation | null): PlaceholderView[] {
  return all.filter((p) => p.kind === "TEXT" && (where === null || p.allowedIn.includes(where)));
}

/** The CTA `link` select: LINK placeholders allowed on a button. */
export function linkPlaceholders(all: readonly PlaceholderView[]): PlaceholderView[] {
  return all.filter((p) => p.kind === "LINK" && p.allowedIn.includes("cta"));
}

/** Insert `{{name}}` over the selection [start, end) (clamped); returns the new value and the caret after the token. */
export function insertToken(value: string, name: string, start: number | null, end: number | null): { value: string; caret: number } {
  const token = `{{${name}}}`;
  const len = value.length;
  const s = start === null || !Number.isFinite(start) ? len : Math.max(0, Math.min(len, start));
  const e = end === null || !Number.isFinite(end) ? s : Math.max(s, Math.min(len, end));
  return { value: value.slice(0, s) + token + value.slice(e), caret: s + token.length };
}

/** "Text · fallback “your institution” · sample “Example Bank”" (fallback / sample are code-defined and synthetic). */
export function placeholderHint(p: PlaceholderView): string {
  return `${p.kind === "LINK" ? "Link" : "Text"} · fallback “${p.fallback || "none"}” · sample “${p.sample}”`;
}

// ── Structure (§2.2, manual drafts) ─────────────────────────────────────────────

export interface Allowed { ok: boolean; why: string | null }
const yes: Allowed = { ok: true, why: null };
const no = (why: string): Allowed => ({ ok: false, why });

/**
 * May a block of `kind` be added? The §2.2 rules for a manual draft: allowed
 * kinds per channel, the block count, at most one hero / cta (and one in-app
 * paragraph). Blocks MAY be added, removed and reordered by hand — the
 * structure lock (STRUCTURE_CHANGED) applies to AI suggestions only (§2.5, §4.4).
 */
export function canAddBlock(body: ContentBody, channel: EditableChannel, kind: ContentBlockKind, limits: Limits): Allowed {
  if (!BLOCK_KINDS[channel].includes(kind)) return no(`${CHANNEL_WORD[channel]} messages can’t have a ${BLOCK_LABEL[kind].toLowerCase()} block.`);
  if (body.blocks.length >= limits.blocks) return no(`At most ${n(limits.blocks)} blocks.`);
  const has = (k: ContentBlockKind) => body.blocks.some((b) => b.kind === k);
  if (kind === "hero" && has("hero")) return no("Only one heading block.");
  if (kind === "cta" && has("cta")) return no("Only one button.");
  if (kind === "paragraph" && channel === "IN_APP" && has("paragraph")) return no("In-app messages have one paragraph.");
  return yes;
}

/** A new block of `kind`: hero goes first; in-app paragraph before the button; anything else at the end. */
export function addBlock(body: ContentBody, channel: EditableChannel, kind: ContentBlockKind, placeholders: readonly PlaceholderView[]): ContentBody {
  const block: ContentBlock =
    kind === "hero" ? { kind: "hero", heading: "" }
    : kind === "paragraph" ? { kind: "paragraph", text: "" }
    : kind === "cta" ? { kind: "cta", label: "", link: linkPlaceholders(placeholders)[0]?.name ?? "" }
    : kind === "info" ? { kind: "info", items: [""] }
    : { kind: "divider" };
  const blocks = [...body.blocks];
  if (kind === "hero") blocks.unshift(block);
  else if (channel === "IN_APP" && kind === "paragraph") {
    const cta = blocks.findIndex((b) => b.kind === "cta");
    blocks.splice(cta === -1 ? blocks.length : cta, 0, block);
  } else blocks.push(block);
  return { ...body, blocks };
}

export function canRemoveBlock(body: ContentBody, channel: EditableChannel, index: number): Allowed {
  if (index < 0 || index >= body.blocks.length) return no("No such block.");
  if (body.blocks.length <= MIN_BLOCKS[channel]) return no("An email needs at least one block.");
  return yes;
}

export function removeBlock(body: ContentBody, index: number): ContentBody {
  return { ...body, blocks: body.blocks.filter((_, i) => i !== index) };
}

/** A heading block stays first: it never moves, and nothing moves above it. */
export function canMoveBlock(body: ContentBody, index: number, dir: -1 | 1): Allowed {
  const to = index + dir;
  if (index < 0 || index >= body.blocks.length || to < 0 || to >= body.blocks.length) return no("Already at the edge.");
  if (body.blocks[index].kind === "hero" || body.blocks[to].kind === "hero") return no("The heading block stays first.");
  return yes;
}

export function moveBlock(body: ContentBody, index: number, dir: -1 | 1): ContentBody {
  if (!canMoveBlock(body, index, dir).ok) return body;
  const blocks = [...body.blocks];
  [blocks[index], blocks[index + dir]] = [blocks[index + dir], blocks[index]];
  return { ...body, blocks };
}

/** Add / remove a list item (≤ `maxItems` — the server's `limits.infoItems` via blockLimits — and ≥ 1) or the optional hero greeting / list title. */
export function editBlock(body: ContentBody, index: number, op: "add-item" | "remove-item" | "toggle-greeting" | "toggle-title" | "toggle-ordered", item?: number, maxItems: number = FIXED_LIMITS.infoItems): ContentBody {
  const b = body.blocks[index];
  if (!b) return body;
  let next: ContentBlock = b;
  if (b.kind === "info" && op === "add-item" && b.items.length < maxItems) next = { ...b, items: [...b.items, ""] };
  else if (b.kind === "info" && op === "remove-item" && item !== undefined && b.items.length > 1) next = { ...b, items: b.items.filter((_, i) => i !== item) };
  else if (b.kind === "info" && op === "toggle-title") next = b.title === undefined ? { ...b, title: "" } : (({ title: _t, ...rest }) => rest)(b);
  else if (b.kind === "info" && op === "toggle-ordered") next = { ...b, ordered: !b.ordered };
  else if (b.kind === "hero" && op === "toggle-greeting") next = b.greeting === undefined ? { ...b, greeting: "" } : (({ greeting: _g, ...rest }) => rest)(b);
  if (next === b) return body;
  return { ...body, blocks: body.blocks.map((x, i) => (i === index ? next : x)) };
}

// ── Controls from the viewer block (§1.1) ───────────────────────────────────────

export interface Control { shown: boolean; enabled: boolean; why: string | null }

export const LOCK_TEXT: Record<"PROTECTED" | "NOT_EDITABLE", string> = {
  PROTECTED: "Protected: this message carries security or ceremony copy, so its content can’t be edited.",
  NOT_EDITABLE: "Not editable: this message’s content is fixed in code (operator mail, banners, or a status that isn’t live).",
};

export const VIEWER_WHY = {
  edit: "Your access lets you view this content, not edit it.",
  publish: "Your access doesn’t include publishing content.",
  rollback: "Your access doesn’t include restoring earlier versions.",
  rollbackNoTarget: "Nothing has been published yet, so there is nothing to restore.",
  ai: "Your access doesn’t include AI assistance.",
} as const;

/** The restore "why": the server's `rollbackUnavailableReason` (v1.1.1); the history-derived guess only when it is absent. */
export function rollbackWhy(v: Pick<Viewer, "rollbackUnavailableReason">, hasRollbackTarget: boolean): string {
  if (v.rollbackUnavailableReason === "NOTHING_TO_RESTORE") return VIEWER_WHY.rollbackNoTarget;
  if (v.rollbackUnavailableReason === "NO_PERMISSION") return VIEWER_WHY.rollback;
  return hasRollbackTarget ? VIEWER_WHY.rollback : VIEWER_WHY.rollbackNoTarget;
}

export interface EditorControls {
  locked: string | null;
  edit: Control;
  save: Control;
  publish: Control;
  rollback: Control;
  ai: Control;
}

export interface ControlFacts {
  viewer: Viewer;
  locked: VersionsResponse["locked"];
  contentEditable: boolean;
  ai: AiAvailability;
  /** The editor holds unsaved changes. */
  dirty: boolean;
  /** Errors in the CURRENT live check (stale checks don't block; the server re-validates). */
  blockingErrors: boolean;
  /** A save is refused while a CONFLICT is unresolved (reload first). */
  conflict: boolean;
  /** The saved version the editor is on (null = the code default / nothing saved yet). */
  base: Pick<TemplateVersionDTO, "id" | "state"> | null;
  /** An AI suggestion loaded into the editor has expired. */
  suggestionExpired: boolean;
  /** Fallback only (a server older than v1.1.1 without `viewer.rollbackUnavailableReason`): derived from the history. */
  hasRollbackTarget: boolean;
}

const hidden: Control = { shown: false, enabled: false, why: null };
const on: Control = { shown: true, enabled: true, why: null };
const off = (why: string): Control => ({ shown: true, enabled: false, why });

/**
 * Every control, from the server's `viewer` block and the leg lock. A locked
 * leg renders NO editing control (only the reason). A control the viewer can't
 * use is shown disabled with one line saying why; the server stays the authority
 * (a fresh-auth / TOTP refusal still arrives as a 401/403 on the write).
 */
export function editorControls(f: ControlFacts): EditorControls {
  const lock = f.locked ? LOCK_TEXT[f.locked.reason] : !f.contentEditable ? LOCK_TEXT.NOT_EDITABLE : null;
  if (lock) return { locked: lock, edit: hidden, save: hidden, publish: hidden, rollback: hidden, ai: hidden };
  const v = f.viewer;
  const edit = v.canEditContent ? on : off(VIEWER_WHY.edit);
  const save = !v.canEditContent ? off(VIEWER_WHY.edit)
    : f.conflict ? off("Reload the latest version first — your text stays in the editor.")
    : f.suggestionExpired ? off("The AI suggestion expired. Request a new one, or discard it to go back to your text.")
    : !f.dirty ? off("No unsaved changes.")
    : f.blockingErrors ? off("Fix the errors first.")
    : on;
  const publish = !v.canPublish ? off(VIEWER_WHY.publish)
    : f.dirty ? off("Save the draft first; only a saved draft can be published.")
    : !f.base || f.base.state !== "DRAFT" ? off("Open a saved draft to publish it.")
    : on;
  const rollback = !v.canRollback ? off(rollbackWhy(v, f.hasRollbackTarget)) : on;
  const ai = !v.canAiSuggest ? off(VIEWER_WHY.ai)
    : !f.ai.available ? off(aiUnavailableText(f.ai.reason ?? "KILL_SWITCH", f.ai.detail ?? null))
    : f.dirty ? off("Save first: AI polishes a saved version, so the suggestion has an unchanging original.")
    : !f.base ? off("Save a draft first: AI polishes a saved version.")
    : on;
  return { locked: null, edit, save, publish, rollback, ai };
}

// ── AI (§4.5) ───────────────────────────────────────────────────────────────────

const PROVIDER_DETAIL: Record<string, string> = {
  TIMEOUT: "the AI provider timed out",
  REFUSED: "the AI provider declined the request",
  QUOTA: "the AI provider’s quota is exhausted",
  RATE_LIMITED: "the AI provider is rate-limiting requests; try again in a minute",
  UNPRICED_MODEL: "the configured model has no price on record, so it is not called",
  FAILED: "the AI provider call failed",
};

/** One plain-English sentence per unavailable reason. Manual editing always works (§4.7). */
export function aiUnavailableText(reason: AiUnavailableReason, detail: string | null): string {
  switch (reason) {
    case "KILL_SWITCH":
      return detail === "MAINTENANCE" ? "AI assistance is off during maintenance. Manual editing still works."
        : detail === "UNREADABLE" || detail === "UNAVAILABLE" ? "AI assistance is off because the AI pause setting couldn’t be read (it fails closed). Manual editing still works."
        : "AI assistance is paused platform-wide. Manual editing still works.";
    case "COST_FREEZE":
      return detail === "UNVERIFIED" ? "AI assistance is off because the platform cost freeze couldn’t be verified (it fails closed). Manual editing still works."
        : "AI assistance is off while the platform cost freeze is on. Manual editing still works.";
    case "ALLOWANCE":
      return detail === "UNAVAILABLE" ? "AI assistance is off because your daily AI allowance couldn’t be read (it fails closed). Manual editing still works."
        : "Your daily AI authoring allowance is used up; it resets at 00:00 UTC. Manual editing still works.";
    case "PROVIDER":
      return `No suggestion: ${PROVIDER_DETAIL[detail ?? "FAILED"] ?? PROVIDER_DETAIL.FAILED}. Nothing was changed; try again or edit by hand.`;
  }
}

/** Why "Accept into editor" is off (null = it may be accepted). */
export function aiAcceptWhy(r: Pick<AiSuggestResult, "baseVersionId" | "changes">, base: Pick<TemplateVersionDTO, "id"> | null, editorBlock: string | null, expired: boolean): string | null {
  if (r.changes.length === 0) return "Nothing to accept: the suggestion matches your saved text.";
  if (expired) return "This suggestion expired. Request a new one.";
  if (editorBlock) return editorBlock;
  if (!base || r.baseVersionId !== base.id) return "The editor has moved to another version since this suggestion was made. Request a new one.";
  return null;
}

/** "12 AI calls left today" (or null when the server didn't say). */
export function aiRemainingText(ai: AiAvailability): string | null {
  if (!ai.available || ai.remainingCallsToday === undefined) return null;
  return `${n(ai.remainingCallsToday)} AI call${ai.remainingCallsToday === 1 ? "" : "s"} left today`;
}

export const NOTE_CATEGORY_LABEL: Record<AiSuggestResult["notes"][number]["category"], string> = {
  GRAMMAR: "Grammar", SPELLING: "Spelling", TONE: "Tone", CLARITY: "Clarity", CONSISTENCY: "Consistency",
};

export function notesByCategory(notes: AiSuggestResult["notes"], body: ContentBody | null): Array<{ category: string; label: string; notes: Array<{ where: string; text: string }> }> {
  const order = Object.keys(NOTE_CATEGORY_LABEL) as Array<keyof typeof NOTE_CATEGORY_LABEL>;
  return order
    .map((c) => ({ category: c, label: NOTE_CATEGORY_LABEL[c], notes: notes.filter((x) => x.category === c).map((x) => ({ where: locationLabel(x.location, body), text: x.text })) }))
    .filter((g) => g.notes.length > 0);
}

/** Expiry wording from the server's `expiresAt` and a caller-supplied now (no clock here). */
export function expiryText(expiresAt: string, nowMs: number): { text: string; expired: boolean } {
  const t = Date.parse(expiresAt);
  if (Number.isNaN(t)) return { text: "Expiry unknown", expired: false };
  const mins = Math.round((t - nowMs) / 60_000);
  if (mins <= 0) return { text: "Expired — request a new suggestion", expired: true };
  return { text: mins >= 120 ? `Expires in ${n(Math.floor(mins / 60))} h` : `Expires in ${n(mins)} min`, expired: false };
}

// ── Diffs ───────────────────────────────────────────────────────────────────────

export interface DiffRow { key: string; label: string; before: string | null; after: string | null }

/** The AI's `changes[]`, labelled against the base (changed fields only, document order, §4.3). */
export function changeRows(r: Pick<AiSuggestResult, "changes" | "base">): DiffRow[] {
  return r.changes.map((c) => ({ key: fieldKey(c.location), label: locationLabel(c.location, r.base), before: c.before, after: c.after }));
}

/** Text of every field plus each block's kind and button link: what a diff compares. */
function comparable(body: ContentBody): Map<string, { label: string; value: string }> {
  const m = new Map<string, { label: string; value: string }>();
  m.set("subject", { label: "Subject", value: body.subject });
  if (body.preheader !== null) m.set("preheader", { label: "Preheader", value: body.preheader });
  body.blocks.forEach((b, i) => {
    const at = (prop: BlockProp, itemIndex?: number): ContentLocation => ({ field: "block", blockIndex: i, prop, ...(itemIndex !== undefined ? { itemIndex } : {}) });
    const put = (loc: ContentLocation, value: string) => m.set(fieldKey(loc), { label: locationLabel(loc, body), value });
    m.set(`b${i}`, { label: `Block ${i + 1}`, value: BLOCK_LABEL[b.kind] ?? String(b.kind) });
    switch (b.kind) {
      case "hero": put(at("heading"), b.heading); if (b.greeting !== undefined) put(at("greeting"), b.greeting); break;
      case "paragraph": put(at("text"), b.text); break;
      case "cta": put(at("label"), b.label); put(at("link"), `{{${b.link}}}`); break;
      case "info": if (b.title !== undefined) put(at("title"), b.title); b.items.forEach((x, j) => put(at("items", j), x)); break;
      default: break;
    }
  });
  return m;
}

/** Field-by-field differences (before = `from`, after = `to`); structure differences appear as block-kind rows. */
export function diffBodies(from: ContentBody, to: ContentBody): DiffRow[] {
  const a = comparable(from);
  const b = comparable(to);
  const keys = [...new Set([...a.keys(), ...b.keys()])];
  return keys
    .filter((k) => a.get(k)?.value !== b.get(k)?.value)
    .map((k) => ({ key: k, label: (b.get(k) ?? a.get(k))!.label, before: a.get(k)?.value ?? null, after: b.get(k)?.value ?? null }));
}

export const sameBody = (a: ContentBody, b: ContentBody) => JSON.stringify(a) === JSON.stringify(b);

export function bodyOfVersion(v: Pick<TemplateVersionDTO, "subject" | "preheader" | "blocks">): ContentBody {
  return { subject: v.subject, preheader: v.preheader, blocks: v.blocks };
}

// ── Versions ────────────────────────────────────────────────────────────────────

export const VERSION_STATE_LABEL: Record<VersionState, string> = { DRAFT: "Draft", PUBLISHED: "Live", SUPERSEDED: "Superseded" };
export const VERSION_STATE_TONE: Record<VersionState, StatusTone> = { DRAFT: "info", PUBLISHED: "ok", SUPERSEDED: "muted" };
export const CREATED_BY_LABEL: Record<VersionCreatedByKind, string> = { OPERATOR: "Operator", AI_ASSISTED: "AI-assisted", ROLLBACK: "Restore" };

export function liveText(live: LiveContent): string {
  return live.source === "PUBLISHED" ? `Published v${live.version}` : "Code default";
}

/** "AI-assisted · edited after accepting" / "Restore of an earlier version". */
export function provenanceText(v: Pick<TemplateVersionDTO, "createdBy" | "aiEditedAfterAccept" | "restoredFromVersionId">): string {
  if (v.createdBy.kind === "AI_ASSISTED") return v.aiEditedAfterAccept ? "AI-assisted · edited after accepting" : "AI-assisted · accepted as suggested";
  if (v.createdBy.kind === "ROLLBACK") return v.restoredFromVersionId === "code-default" ? "Restore of the code default" : "Restore of an earlier version";
  return "Operator";
}

/** A rollback (restore) target: a SUPERSEDED version (never a DRAFT or the live one, §3.5). */
export const isRestorable = (v: Pick<TemplateVersionDTO, "state">) => v.state === "SUPERSEDED";

// ── Drafts and write outcomes ───────────────────────────────────────────────────

export type DraftSource = { kind: "MANUAL" } | { kind: "AI_SUGGESTION"; suggestionId: string; expiresAt: string };

export interface Draft {
  body: ContentBody;
  /** The saved version this draft started from (null = the code default). */
  parentVersionId: string | null;
  source: DraftSource;
  /** The stream revision the draft will send as `expectedRevision`. */
  revision: number;
  dirty: boolean;
  /** Before an AI suggestion was loaded: what "Discard suggestion" restores. */
  beforeSuggestion: { body: ContentBody; dirty: boolean; parentVersionId: string | null } | null;
}

/** The unsaved-content guard (drawer close, another row, another leg): asks first when dirty. */
export const DISCARD_CONTENT_TEXT = "Discard your unsaved content changes?";
export function guardDiscard(dirty: boolean, confirm: (text: string) => boolean): boolean {
  return !dirty || confirm(DISCARD_CONTENT_TEXT);
}

export const CONTENT_CONFLICT_TEXT = "Someone else changed this content since you opened it. Your text is still here — reload the latest version, check it, then save again.";

/** The editor's starting draft: the live content (published version, or the code default). */
export function draftFrom(body: ContentBody, parentVersionId: string | null, revision: number): Draft {
  return { body, parentVersionId, source: { kind: "MANUAL" }, revision, dirty: false, beforeSuggestion: null };
}

export function editDraft(d: Draft, body: ContentBody): Draft {
  return { ...d, body, dirty: true };
}

/** Accept an AI suggestion: an UNSAVED draft from the suggestion, based on its base version (§3.3 step 3). */
export function acceptSuggestion(d: Draft, s: Pick<AiSuggestResult, "suggestionId" | "baseVersionId" | "suggestion" | "expiresAt">): Draft {
  return {
    body: s.suggestion,
    parentVersionId: s.baseVersionId,
    source: { kind: "AI_SUGGESTION", suggestionId: s.suggestionId, expiresAt: s.expiresAt },
    revision: d.revision,
    dirty: true,
    beforeSuggestion: { body: d.body, dirty: d.dirty, parentVersionId: d.parentVersionId },
  };
}

export function discardSuggestion(d: Draft): Draft {
  if (!d.beforeSuggestion) return { ...d, source: { kind: "MANUAL" } };
  return { ...d, body: d.beforeSuggestion.body, dirty: d.beforeSuggestion.dirty, parentVersionId: d.beforeSuggestion.parentVersionId, source: { kind: "MANUAL" }, beforeSuggestion: null };
}

/** The editor's state: the draft and the saved version it sits on (null = the code default). */
export interface EditorState { draft: Draft; base: TemplateVersionDTO | null }

export type SaveOutcome =
  | { kind: "saved"; version: TemplateVersionDTO; notice: string }
  | { kind: "conflict"; current: number | null; notice: string }
  | { kind: "invalid"; issues: ContentIssue[]; notice: string }
  | { kind: "refused"; notice: string; expired?: boolean };

/** What a draft save's response MEANS (independent of the editor's state). */
export function saveOutcome(r: CommsReadResult<{ result: TemplateVersionDTO }>): SaveOutcome {
  if (r.kind === "ok") return { kind: "saved", version: r.data.result, notice: `Saved as draft v${r.data.result.version}.` };
  if (r.kind === "error" && r.status === 409 && r.code === "CONFLICT") return { kind: "conflict", current: r.current ?? null, notice: CONTENT_CONFLICT_TEXT };
  if (r.kind === "error" && r.code === "CONTENT_INVALID") return { kind: "invalid", issues: r.issues ?? [], notice: "Not saved: fix the errors shown below." };
  if (r.kind === "error" && r.code === "SUGGESTION_EXPIRED") return { kind: "refused", expired: true, notice: "Not saved: the AI suggestion expired. Request a new one, or discard it to go back to your text." };
  return { kind: "refused", notice: `Not saved: ${writeRefusalText(r)}` };
}

/**
 * The editor state after a save, applied to the state AT RESOLUTION (`prev`),
 * never to the snapshot taken at the click. `sent` is the body that was sent.
 *   • any refusal (409 / 400 / 403 / 429 / 503 / network) ⇒ `prev` unchanged —
 *     including anything typed while the request was in flight;
 *   • success and nothing typed since ⇒ a clean draft on the saved version;
 *   • success but the operator kept typing ⇒ THEIR text stays (still dirty), now
 *     based on the saved version and its revision (a MANUAL edit on top of it).
 */
export function stateAfterSave(prev: EditorState, sent: ContentBody, r: CommsReadResult<{ result: TemplateVersionDTO }>): EditorState {
  if (r.kind !== "ok") return prev;
  const v = r.data.result;
  if (sameBody(prev.draft.body, sent)) return { draft: draftFrom(bodyOfVersion(v), v.id, v.revision), base: v };
  return { draft: { ...prev.draft, parentVersionId: v.id, revision: v.revision, source: { kind: "MANUAL" }, beforeSuggestion: null, dirty: true }, base: v };
}

/**
 * The editor state after a publish / restore made `published` (null = the code
 * default) live at `revision`. A dirty draft is NEVER replaced: it keeps its text,
 * lineage and base, and only aims at the new revision.
 */
export function stateAfterLiveChange(prev: EditorState, change: { revision: number; published: TemplateVersionDTO | null; body: ContentBody }): EditorState {
  if (prev.draft.dirty) return { ...prev, draft: { ...prev.draft, revision: change.revision } };
  return { draft: draftFrom(change.body, change.published?.id ?? null, change.revision), base: change.published };
}

/**
 * After a SUCCESSFUL reload that resolves a CONFLICT: the SAME unsaved text, aimed
 * at the server's present revision. The parent is kept even when it is not on
 * the first page — versions are never deleted, and the server validates lineage.
 */
export function rebaseDraft(d: Draft, latest: Pick<VersionsResponse, "revision">): Draft {
  return { ...d, revision: latest.revision };
}

/** "about 45 min" / "about 3 h" for a Retry-After. */
export function retryAfterText(seconds: number | null | undefined): string | null {
  if (!seconds || seconds <= 0) return null;
  const mins = Math.ceil(seconds / 60);
  return mins < 90 ? `Try again in about ${n(mins)} min.` : `Try again in about ${n(Math.round(mins / 60))} h.`;
}

/** One sentence for any refused write (409 codes, 400, 401/403 with the house copy, 429, 503, network). */
export function writeRefusalText(r: CommsReadResult<unknown>): string {
  switch (r.kind) {
    case "ok": return "";
    case "denied": return r.error;
    case "rate-limited": return "Too many requests — wait a moment and try again.";
    case "unavailable": return r.ai
      ? [aiUnavailableText(r.ai.reason, r.ai.detail), retryAfterText(r.ai.retryAfterSeconds)].filter(Boolean).join(" ")
      : "The service is unavailable right now (503). Nothing was changed.";
    case "not-found": return r.error;
    case "coming-soon": return "This action isn’t deployed yet.";
    case "error":
      switch (r.code) {
        case "CONFLICT": return CONTENT_CONFLICT_TEXT;
        case "PROTECTED": return LOCK_TEXT.PROTECTED;
        case "NOT_EDITABLE": return LOCK_TEXT.NOT_EDITABLE;
        case "STALE_DRAFT": return "Someone published since this draft was started. Open the live version, edit from it and save a new draft.";
        case "INVALID_STATE": return "That version can’t take this action in its current state (only drafts publish; only superseded versions restore).";
        case "WARNINGS_UNACKNOWLEDGED": return "This version has warnings: tick the acknowledgement and publish again.";
        case "SUGGESTION_REJECTED": return "The AI suggestion failed the content checks and was discarded. Nothing was changed.";
        default: return r.error;
      }
  }
}
