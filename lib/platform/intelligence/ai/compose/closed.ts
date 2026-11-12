/**
 * lib/platform/intelligence/ai/compose/closed.ts  (Platform AI — CLOSED values a placeholder may render, S2 09io A1 / B2)
 *
 * The ONLY value shapes the server renders for a `{{r:h|<closed field>}}` (a record's closed T1 field) or a
 * `{{a:<tool>|<resultPath>}}` (a pack aggregate's closed result path):
 *
 *   count     a non-negative safe integer        → "1,234" (en-US grouping)
 *   isoTime   a UTC ISO-8601 instant              → "2026-11-12 03:18 UTC" (the server's stamp form)
 *   code      a value from a CLOSED code set      → its words ("NEEDS_REAUTH" → "needs reauth",
 *             (the schema / the path spec lists it)   "firstConnection" → "first connection")
 *
 * There is no free-text shape: a name, an email, a username, an institution / provider text, a note or any
 * amount can never be one of these (the record schema / path allowlist validators refuse the fields that could
 * carry them; this module refuses any value outside the three shapes). Formatting is server code — the model
 * never writes the value, so the leftover-digit rule (compose/placeholders.ts) is unchanged.
 *
 * PURE: no I/O, no clock, no module state. compose/* never imports ../core.
 */

/** The closed value types a placeholder may render (A1: enum / code / count / server-formatted date). */
export const CLOSED_VALUE_TYPES = ["count", "isoTime", "code"] as const;
export type ClosedValueType = (typeof CLOSED_VALUE_TYPES)[number];

/** A closed value as captured from THIS turn's tool result (never model text). */
export interface ClosedValue { readonly type: ClosedValueType; readonly value: number | string }

export const CLOSED_ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
/** A code as stored / rendered: a closed-set member is always this shape (letters, digits, `_`, `-`, `.`; ≤ 64). */
export const CLOSED_CODE_SHAPE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

/** True when `v` is a valid value of `type` (a code must also be in `values` when given). */
export function closedValueOk(type: ClosedValueType, v: unknown, values?: readonly string[]): v is number | string {
  switch (type) {
    case "count": return typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
    case "isoTime": return typeof v === "string" && CLOSED_ISO_TIME.test(v) && !Number.isNaN(Date.parse(v));
    case "code": return typeof v === "string" && CLOSED_CODE_SHAPE.test(v) && (values === undefined || values.includes(v));
  }
}

/** The type a STORED closed value has (a number ⇒ count, an instant ⇒ isoTime, else a code shape), or null. */
export function closedTypeOf(v: unknown): ClosedValueType | null {
  if (closedValueOk("count", v)) return "count";
  if (closedValueOk("isoTime", v)) return "isoTime";
  if (closedValueOk("code", v)) return "code";
  return null;
}

/** "NEEDS_REAUTH" → "needs reauth"; "firstConnection" → "first connection"; "stale-unverified" → "stale unverified". */
export function codeWords(c: string): string {
  return c.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
}

/** The server's stamp form for an instant ("2026-11-12 03:18 UTC"). */
export function closedStamp(iso: string): string {
  const d = new Date(Date.parse(iso)).toISOString();
  return `${d.slice(0, 10)} ${d.slice(11, 16)} UTC`;
}

/** Server-formatted text for a closed value, or null when it is not one (the caller renders "unavailable"). */
export function formatClosedValue(type: ClosedValueType, v: unknown): string | null {
  if (!closedValueOk(type, v)) return null;
  switch (type) {
    case "count": return (v as number).toLocaleString("en-US");
    case "isoTime": return closedStamp(v as string);
    case "code": return codeWords(v as string);
  }
}

/**
 * Field / path-segment words a placeable may NEVER be named after (A1 / B2): identities, free text, institution
 * text and amounts. Checked against every WORD of a field name / path segment (camelCase, `_`, `-` and `.` split:
 * "firstName" ⇒ first, name; "unhealthyByInstitution" ⇒ …, institution) — on top of the type rule (a field of
 * one of the closed types only), so a renamed free-text or amount field is refused twice. (A closed vocabulary
 * key such as the incident domain "balances" is one word and not "balance": it names a domain, not an amount.)
 */
export const PLACEABLE_FORBIDDEN_WORDS = [
  "name", "names", "email", "username", "institution", "label", "note", "notes", "message", "text", "detail", "description",
  "address", "amount", "balance", "usd", "dollar", "dollars", "cost", "spend", "price", "steps", "phone", "id", "ids", "handle",
] as const;

export const placeableNameForbidden = (s: string): boolean =>
  codeWords(s.replace(/\./g, " ")).split(" ").some((w) => (PLACEABLE_FORBIDDEN_WORDS as readonly string[]).includes(w));
