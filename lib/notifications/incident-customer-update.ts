/**
 * lib/notifications/incident-customer-update.ts  (Incident customer update — PURE, client-safe)
 *
 * The FIXED customer-facing template of an operator-approved incident update
 * (owner yes; S2 ruling 09gg (c)): a fixed title, a fixed opening and closing,
 * and exactly ONE operator-editable paragraph between them. The registry entry
 * INCIDENT_CUSTOMER_UPDATE (lib/notifications/registry.ts) renders through
 * `renderIncidentCustomerUpdate`, and the preview route renders the very same
 * function — what the operator previews is what the customer receives.
 *
 * Nothing here is content-editable (no lib/notifications/content leg spec): the
 * frame is code. The paragraph is validated BEFORE it is stored
 * (lib/platform/incidents/customer-update/core.ts lintIncidentCustomerUpdate);
 * render data is still untrusted here, so the paragraph is re-bounded (trimmed,
 * line breaks folded, capped at the limit) and an absent one renders the frame
 * alone — render({}) is always safe.
 *
 * PURE: no I/O.
 */

/** S2 09gg (c) — the one editable paragraph's maximum length, in characters. */
export const INCIDENT_UPDATE_PARAGRAPH_MAX = 600;

export const INCIDENT_UPDATE_TITLE = "An update from our support team";
export const INCIDENT_UPDATE_OPENING = "We noticed a problem with one of your connections and wanted to let you know what is happening.";
export const INCIDENT_UPDATE_CLOSING = "You can check your connections at any time on the Connections page. If you have questions, reply to support.";
export const INCIDENT_UPDATE_HREF = "/dashboard/connections";

/** The paragraph as the template will show it: trimmed, whitespace folded, capped. "" when absent. */
export function boundedParagraph(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.replace(/\s+/g, " ").trim().slice(0, INCIDENT_UPDATE_PARAGRAPH_MAX);
}

/** The full message: the fixed frame around the one paragraph. */
export function renderIncidentCustomerUpdate(data: Readonly<Record<string, unknown>>): { title: string; body: string; href: string } {
  const paragraph = boundedParagraph(data.paragraph);
  return {
    title: INCIDENT_UPDATE_TITLE,
    body: [INCIDENT_UPDATE_OPENING, paragraph, INCIDENT_UPDATE_CLOSING].filter((s) => s !== "").join("\n\n"),
    href: INCIDENT_UPDATE_HREF,
  };
}
