/**
 * lib/platform/intelligence/ai/authz/people-chip.ts  (Platform AI — the @ people picker's CHIP wire form, owner 2026-11-10)
 *
 * S2 09fc P3 / P6. An operator picks a customer with `@` in the composer (components/platform/
 * platform-ai-people-picker.tsx). The picker's display label (a username or an email) is shown ONLY to
 * that operator, in that browser tab, and is NEVER sent back: the draft the server receives carries the
 * opaque CHIP TOKEN `[[cust:<8 hex>]]` instead — the 8 hex of the customer's PRIV-ref reference
 * (lib/platform/opaque-user-ref.ts; already T1, shown on every operator surface).
 *
 * The server treats a chip EXACTLY like a typed `user #<8 hex>` reference (authz/subject.ts extracts it
 * as an OPAQUE_REF identifier): the P5 limiter, the fresh CS-tier eligibility, the bounded digest lookup,
 * the PLATFORM_AI_SUBJECT_LOOKUP audit row and a per-turn handle — or the one uniform
 * `[customer not resolved]` literal for a forged / unknown chip. The STORED text of a chip is `[customer]`
 * (storedSubjectText): no label, no reference.
 *
 * Pure and import-free (client-safe).
 */

/** The chip's wire form. 8 lowercase hex = a PRIV-ref token; nothing else is a chip. */
export const CHIP_TOKEN_SOURCE = String.raw`\[\[cust:([0-9a-f]{8})\]\]`;
export const CHIP_REF = /^[0-9a-f]{8}$/;

export const chipToken = (ref: string): string => (CHIP_REF.test(ref) ? `[[cust:${ref}]]` : "");

/** One picked customer in the composer: the opaque ref and the label only this operator sees. */
export interface DraftChip { readonly ref: string; readonly label: string }

/** The mention form of a chip in the draft text the operator sees. */
export const chipMention = (label: string): string => `@${label}`;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A mention ends at a character that cannot continue a username / email. */
const mentionRe = (label: string) => new RegExp(`${escapeRe(chipMention(label))}(?![A-Za-z0-9._%+@-])`, "g");

/** The chips whose mention is still in the draft (an edited / deleted mention is no longer a chip). */
export function liveChips(draft: string, chips: readonly DraftChip[]): DraftChip[] {
  return chips.filter((c, i) => CHIP_REF.test(c.ref) && c.label.length > 0 && chips.findIndex((x) => x.label === c.label) === i && mentionRe(c.label).test(draft));
}

/**
 * The text the client SENDS: every live chip's mention ⇒ its chip token. The label never survives
 * serialisation (longest labels first, so one label that prefixes another cannot leave a tail).
 */
export function serializeDraft(draft: string, chips: readonly DraftChip[]): string {
  let out = draft;
  for (const c of [...liveChips(draft, chips)].sort((a, b) => b.label.length - a.label.length)) {
    out = out.replace(mentionRe(c.label), chipToken(c.ref));
  }
  return out;
}

/** The text the operator's OWN screen shows for a sent question (memory only): a chip ⇒ `@label`, an unknown chip ⇒ `[customer]`. */
export function displayQuestion(wire: string, chips: readonly DraftChip[]): string {
  return wire.replace(new RegExp(CHIP_TOKEN_SOURCE, "g"), (_m, ref: string) => {
    const c = chips.find((x) => x.ref === ref);
    return c ? chipMention(c.label) : "[customer]";
  });
}

/** The active `@query` before the caret, or null (the picker opens on `@`). */
export function activeMention(draft: string, caret: number): { start: number; query: string } | null {
  const before = draft.slice(0, Math.max(0, Math.min(caret, draft.length)));
  const m = /(?:^|[\s(])@([A-Za-z0-9._+-]{0,64})$/.exec(before);
  if (!m) return null;
  return { start: before.length - m[1].length - 1, query: m[1] };
}

/** Replace the active mention with the chip's mention (and one trailing space). */
export function insertChip(draft: string, mention: { start: number; query: string }, label: string): { draft: string; caret: number } {
  const end = mention.start + 1 + mention.query.length;
  const head = draft.slice(0, mention.start) + chipMention(label) + " ";
  return { draft: head + draft.slice(end).replace(/^ /, ""), caret: head.length };
}

/** Email-shaped text (the client-side hint; the server decides). Checked on the SERIALISED draft, so a chip's label never trips it. */
export const EMAIL_SHAPED = /[^\s@[\]]+@[^\s@[\]]+\.[^\s@[\]]+/;
export const hasEmailShaped = (serialized: string): boolean => EMAIL_SHAPED.test(serialized);

/** The guard's refusal code (server ⇒ client). */
export const USE_PEOPLE_PICKER = "USE_PEOPLE_PICKER";
/** The reminder copy: the picker is offered (P5 callers). */
export const PEOPLE_PICKER_REMINDER = "Looks like you typed a customer's username or email. Use @ to pick the customer so their details stay private.";
/** The reminder copy without the picker (callers without Customer Success lookup): emails only. */
export const EMAIL_REMINDER = "Looks like you typed an email address. Remove it so customer details stay private.";
