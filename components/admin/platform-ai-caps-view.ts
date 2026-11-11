/**
 * components/admin/platform-ai-caps-view.ts  (PLATFORM AI CAPS D5 PR5 — the pure view model)
 *
 * Everything the Admin → Platform AI caps page decides, as pure functions over
 * the read model of GET /api/admin/platform-ai-caps (D5 PR4,
 * lib/platform/ai/platform-ai-caps-admin.ts) — so every rule is testable without
 * a DOM:
 *
 *   · the three request bodies, ONE action each: a blanket save / clear never
 *     carries an override field and an override never carries a blanket field
 *     (the server refuses a mixed body VALIDATION; the UI never builds one);
 *   · `expectedUpdatedAt` is ALWAYS the version the operator loaded (null = "no
 *     row"), so a row that moved is a CONFLICT, never a silent overwrite;
 *   · a reason is required client-side (no body is built without one);
 *   · refusal code → a plain-language sentence; the lowering warning sentence;
 *   · source / value / "fits about N questions" wording — every dollar an ESTIMATE.
 *
 * The SERVER is the authority (fresh SYSTEM_ADMIN, bounds, eligibility, the
 * platform-cap bound, concurrency, the audit). No raw user id is ever rendered:
 * operators are shown by the server's label; the id only travels in a body.
 */

import type { OperatorReasonInput } from "@/components/platform/widgets/policy-editor-kit";
import type {
  BlanketCapName, BlanketCapView, CapOutcomeView, OperatorCapView, PlatformAiCapsMutationResult,
  PlatformAiCapsReadModel, PlatformAiCapsRefusalCode, PlatformAiCapsWarning,
} from "@/lib/platform/ai/platform-ai-caps-admin";

export type { BlanketCapName, BlanketCapView, OperatorCapView, PlatformAiCapsReadModel };

/** GET = read model · POST = one action → { result, model } | { error, code }. SYSTEM_ADMIN only. */
export const PLATFORM_AI_CAPS_URL = "/api/admin/platform-ai-caps";

export const PAGE_TITLE = "Platform AI caps";
export const PAGE_INTRO =
  "Estimated daily spend caps for Platform AI, the operators' assistant. A platform-wide default applies to every operator; " +
  "a per-operator override replaces it for one person. Caps only ever refuse questions: they never turn Platform AI on.";

export const BLANKET_TITLE: Record<BlanketCapName, string> = {
  per_operator: "Per operator per day",
  platform: "Platform per day",
};
export const BLANKET_CAPTION: Record<BlanketCapName, string> = {
  per_operator: "Estimated daily spend cap for each operator without an override.",
  platform: "Estimated daily spend cap for all operators together.",
};

export const SELF_EDIT_NOTE = "Changes to your own cap are recorded as self-edits.";
export const DEFAULT_WORD = "Default";
export const YOU_BADGE = "You";
export const CONFLICT_MESSAGE = "Someone changed this. Reload and try again.";
export const SAVED_TEXT = "Saved.";
export const CLEARED_TEXT = "Cleared. The fallback applies.";
export const RESET_DONE_TEXT = "Reset. The per-operator default applies.";
export const NO_CHANGE_TEXT = "No change: that is already the value.";
export const CLEAR_TEXT = "Clear the stored setting so the deployment fallback (or nothing) applies. Every Platform AI question is judged against the new value immediately.";
export const RESET_OVERRIDE_TEXT = "Remove this operator's override so the per-operator default applies again.";
export const READ_ONLY_EDITED_BY = "Edited by System Admins in Admin → Platform AI caps.";

// ── Wording ───────────────────────────────────────────────────────────────────

export const usd = (n: number): string => `$${n}`;

const SOURCE_WORD: Record<NonNullable<CapOutcomeView["source"]>, string> = {
  OPERATOR_OVERRIDE: "Operator override",
  PLATFORM_SETTING: "Platform setting",
  ENV: "Deployment setting",
  TEST_DEFAULT: "Built-in test default",
  CEILING: "Fixed ceiling",
};

/** Where the value in force comes from, or why there is none. */
export function sourceText(v: Pick<CapOutcomeView, "source" | "refusal">): string {
  if (v.refusal === "CAP_MISSING") return "Not set";
  if (v.refusal === "CAP_INVALID") return "Invalid setting";
  return v.source ? SOURCE_WORD[v.source] : "Not set";
}

/** The value in force, or the word for its absence. */
export function capValueText(v: Pick<CapOutcomeView, "usd" | "refusal">): string {
  if (v.usd !== null) return usd(v.usd);
  return v.refusal === "CAP_INVALID" ? "Invalid" : "Not set";
}

/** "Fits about N questions at worst case", or why it cannot be said. */
export function fitsText(fitsTurns: number | null, v: Pick<CapOutcomeView, "usd" | "refusal">): string {
  if (v.usd === null) return "Every Platform AI question is refused until this resolves.";
  if (fitsTurns === null) return "Worst-case question cost is not priced for the current model.";
  return `Fits about ${fitsTurns} question${fitsTurns === 1 ? "" : "s"} at worst case.`;
}

/** The editor's consequence line for a drafted value: "New cap $5 per UTC day (estimated) · fits about 12 questions at worst case." */
export function newCapLine(valueUsd: number, reserveUsd: number | null): string {
  const base = `New cap ${usd(valueUsd)} per UTC day (estimated)`;
  if (reserveUsd === null || !(reserveUsd > 0)) return `${base}.`;
  const n = Math.floor(valueUsd / reserveUsd + 1e-9);
  return `${base} · fits about ${n} question${n === 1 ? "" : "s"} at worst case.`;
}

/** The stored row, stated: "$3", "not set" or "unreadable". */
export function storedText(b: Pick<BlanketCapView, "stored">): string {
  if (b.stored.state === "SET" && b.stored.usd !== null) return usd(b.stored.usd);
  return b.stored.state === "INVALID" ? "unreadable" : "not set";
}

/** The override cell: "$7", "Invalid" or "Default". */
export function overrideText(op: Pick<OperatorCapView, "override">): string {
  if (!op.override) return DEFAULT_WORD;
  if (op.override.state === "SET" && op.override.dailyUsd !== null) return usd(op.override.dailyUsd);
  return "Invalid";
}

export const VIA_WORD: Record<OperatorCapView["via"], string> = { SYSTEM_ADMIN: "System Admin", PLATFORM_GRANT: "Platform grant" };

/** The "You" badge: the row is the signed-in System Admin. */
export const isSelf = (op: Pick<OperatorCapView, "userId">, selfUserId: string | null): boolean =>
  selfUserId !== null && op.userId === selfUserId;

// ── Input validation ──────────────────────────────────────────────────────────

/** Whole dollars, 0..max. Empty ⇒ an error (clearing is its own action). */
export function validateUsdInput(raw: string, max: number): { value: number | null; error: string | null } {
  const t = raw.trim();
  if (t === "") return { value: null, error: "Enter a whole-dollar amount." };
  if (!/^\d+$/.test(t)) return { value: null, error: "Use a whole number of dollars." };
  const n = Number(t);
  if (n < 0 || n > max) return { value: null, error: `Must be between $0 and ${usd(max)}.` };
  return { value: n, error: null };
}

/** A reason is required: a chosen code (the note is optional). */
export const hasReason = (r: OperatorReasonInput | null | undefined): r is OperatorReasonInput =>
  !!r && typeof r.code === "string" && r.code.length > 0;

// ── Request bodies — ONE action each, the loaded version always carried ──────

export interface SetBlanketBody { action: "SET_BLANKET"; key: BlanketCapName; valueUsd: number | null; reason: OperatorReasonInput; expectedUpdatedAt: string | null }
export interface SetOverrideBody { action: "SET_OVERRIDE"; targetUserId: string; dailyUsd: number; reason: OperatorReasonInput; expectedUpdatedAt: string | null }
export interface ResetOverrideBody { action: "RESET_OVERRIDE"; targetUserId: string; reason: OperatorReasonInput; expectedUpdatedAt: string | null }
export type CapsBody = SetBlanketBody | SetOverrideBody | ResetOverrideBody;

const cleanReason = (r: OperatorReasonInput): OperatorReasonInput => (r.note && r.note.trim() ? { code: r.code, note: r.note.trim() } : { code: r.code });

/** Save (valueUsd a number) or Clear (valueUsd null) ONE blanket cap. Null when there is no reason. */
export function blanketBody(b: Pick<BlanketCapView, "key" | "stored">, valueUsd: number | null, reason: OperatorReasonInput | null): SetBlanketBody | null {
  if (!hasReason(reason)) return null;
  return { action: "SET_BLANKET", key: b.key, valueUsd, reason: cleanReason(reason), expectedUpdatedAt: b.stored.updatedAt };
}

/** Set ONE operator's override. Null when there is no reason. */
export function overrideBody(op: Pick<OperatorCapView, "userId" | "override">, dailyUsd: number, reason: OperatorReasonInput | null): SetOverrideBody | null {
  if (!hasReason(reason)) return null;
  return { action: "SET_OVERRIDE", targetUserId: op.userId, dailyUsd, reason: cleanReason(reason), expectedUpdatedAt: op.override?.updatedAt ?? null };
}

/** Reset ONE operator to the default. Null when there is no reason. */
export function resetBody(op: Pick<OperatorCapView, "userId" | "override">, reason: OperatorReasonInput | null): ResetOverrideBody | null {
  if (!hasReason(reason)) return null;
  return { action: "RESET_OVERRIDE", targetUserId: op.userId, reason: cleanReason(reason), expectedUpdatedAt: op.override?.updatedAt ?? null };
}

// ── Outcomes ──────────────────────────────────────────────────────────────────

/** The platform cap in force, for the ABOVE_PLATFORM_CAP sentence. */
export const platformCapUsd = (m: Pick<PlatformAiCapsReadModel, "blanket"> | null): number | null => m?.blanket.platform.effective.usd ?? null;

/** Refusal code → the sentence the operator reads (the server's sentence where no plainer one exists). */
export function refusalMessage(code: PlatformAiCapsRefusalCode | string | undefined, serverError: string | undefined, platformUsd: number | null): string {
  switch (code) {
    case "ABOVE_PLATFORM_CAP":
      return `Higher than the platform cap${platformUsd === null ? "" : ` (${usd(platformUsd)})`}. Raise the platform cap first.`;
    case "PLATFORM_CAP_NOT_SET": return "Set the platform cap first.";
    case "PLATFORM_CAP_INVALID": return "The platform cap setting is invalid. Fix it first.";
    case "CONFLICT": return CONFLICT_MESSAGE;
    case "FORBIDDEN": return "Only a System Admin can change Platform AI caps.";
    case "NOT_ELIGIBLE": return "That person is no longer a current operator. Reload to see the current list.";
    case "NOT_FOUND": return "There is nothing stored to clear. Reload to see the current values.";
    default: return serverError && serverError.trim() ? serverError : "The change was not saved.";
  }
}

/** "N operators have a cap above the new platform cap; the platform cap applies." */
export function loweringWarningText(w: Pick<PlatformAiCapsWarning, "count"> | null | undefined): string | null {
  if (!w || w.count <= 0) return null;
  return w.count === 1
    ? "1 operator has a cap above the new platform cap; the platform cap applies."
    : `${w.count} operators have a cap above the new platform cap; the platform cap applies.`;
}

export type CapsOutcome =
  | { kind: "applied"; model: PlatformAiCapsReadModel; result: Extract<PlatformAiCapsMutationResult, { ok: true }> }
  | { kind: "refused"; code: string | undefined; message: string; conflict: boolean }
  | { kind: "failed"; message: string };

/** PURE — one POST response (status + parsed JSON) → the outcome the page acts on. */
export function resolveCapsResponse(status: number, json: unknown, current: PlatformAiCapsReadModel | null): CapsOutcome {
  const j = (json ?? {}) as { result?: unknown; model?: unknown; error?: unknown; code?: unknown };
  if (status >= 200 && status < 300 && j.model && j.result && (j.result as { ok?: unknown }).ok === true) {
    return { kind: "applied", model: j.model as PlatformAiCapsReadModel, result: j.result as Extract<PlatformAiCapsMutationResult, { ok: true }> };
  }
  const code = typeof j.code === "string" ? j.code : status === 409 ? "CONFLICT" : status === 403 ? "FORBIDDEN" : undefined;
  if (code === undefined && status >= 500) return { kind: "failed", message: `The request failed (${status}). Nothing was changed.` };
  return { kind: "refused", code, message: refusalMessage(code, typeof j.error === "string" ? j.error : undefined, platformCapUsd(current)), conflict: code === "CONFLICT" };
}

/** The success sentence for an applied action. */
export function appliedText(body: CapsBody, result: { changed: boolean }): string {
  if (!result.changed) return NO_CHANGE_TEXT;
  if (body.action === "RESET_OVERRIDE") return RESET_DONE_TEXT;
  if (body.action === "SET_BLANKET" && body.valueUsd === null) return CLEARED_TEXT;
  return SAVED_TEXT;
}

// ── The read-only Cost Controls card (PLATFORM_OPS READ) ─────────────────────

export const READ_ONLY_CARD_TITLE = "Platform AI (operators)";
