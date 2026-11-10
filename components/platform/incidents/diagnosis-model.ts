/**
 * components/platform/incidents/diagnosis-model.ts  (Incident detail — DIAGNOSIS view-model, PURE)
 *
 * Owner-approved incident-detail UX (2026-11-08), item 2 "Diagnosis". Turns the
 * already-tiered IncidentDetailDTO into what the drawer's Diagnosis section
 * shows. Presentation only — it derives no verdict:
 *   - plain English for the verified (allowlisted) provider code
 *     (lib/platform/incidents/explanations.ts); an unexplained code gets the
 *     generic "we don't recognise" sentence plus the code; a recorded value that
 *     is NOT an allowlisted code is never echoed;
 *   - a CONFIRMED cause is shown apart from a LIKELY one: the incident's own
 *     causeCode (causeStatus CONFIRMED ⇒ "Confirmed cause", HYPOTHESIS ⇒ "Likely
 *     cause (not confirmed)") worded ONLY from the registry
 *     (lib/platform/incidents/codes.ts CAUSE_CODES), and the code table's
 *     probable cause, always labelled likely;
 *   - for a code only the customer can fix (reconnect / re-add class) the text
 *     says so and never suggests a server retry — text only, no control;
 *   - attempts: counts and the last attempt / skip / success / failure times
 *     from the connection's attempts summary (verdict attempt evidence when the
 *     summary is absent);
 *   - prior occurrences: the earlier episodes visible to the read and how each
 *     was closed (closure kind words).
 *
 * TEXT RULES: every sentence is fixed text in code or a registry wording. It
 * reads codes, counts, times and enums only — never `detail`, never provider
 * message text, never an institution name, never a customer id (the diagnosis
 * is identity-free on both tiers).
 */

import { CAUSE_CODES } from "@/lib/platform/incidents/codes";
import { explainProviderError } from "@/lib/platform/incidents/explanations";
import type { IncidentDetailDTO, IncidentRowDTO } from "@/lib/platform/incidents/investigation-dto";
import { attemptsLine, closureText, providerCodeLine, recurrenceLine, whenText } from "./incidents-model";

export const UNRECOGNISED_ERROR_TEXT = "The provider returned an error we don't recognise.";
export const CONFIRMED_CAUSE_LABEL = "Confirmed cause";
export const LIKELY_CAUSE_LABEL = "Likely cause (not confirmed)";
export const RECONNECT_ONLY_TEXT = "This error is fixed only by the customer reconnecting the bank. Retrying the sync from our side can't fix it.";
export const RE_ADD_ONLY_TEXT = "This error is fixed only by the customer adding the connection again: it is gone at the provider. Neither a retry nor a reconnect request can restore it.";
export const NEEDS_REAUTH_TEXT = "The connection is waiting for the customer to sign in again; only the customer reconnecting fixes it.";
/** Earlier episodes listed at most. */
export const PRIOR_EPISODES_SHOWN = 5;

export interface DiagnosisCause {
  status: "confirmed" | "likely";
  label: typeof CONFIRMED_CAUSE_LABEL | typeof LIKELY_CAUSE_LABEL;
  text: string;
  /** incident = the incident's recorded causeCode (registry); provider-code = the code table's probable cause. */
  source: "incident" | "provider-code";
}

export interface DiagnosisStamp { label: string; value: string }

export interface PriorEpisode {
  id: string;
  generation: number;
  firstSeenAt: string;
  closedAt: string | null;
  /** How it closed (closure words), "Still open", or "No longer retained". */
  outcome: string;
}

export interface DiagnosisView {
  /** The explanation is from the verified code table. */
  verified: boolean;
  plainEnglish: string;
  /** "NO_ACCOUNTS · the connection's current error" — allowlisted codes only. */
  codeLine: string | null;
  /** A value was recorded that is not a known code: said, never shown. */
  unrecognisedNote: string | null;
  /** What only the customer can do (text only), or null. */
  customerStep: { kind: "reconnect" | "re-add"; text: string } | null;
  /** Facts the code itself establishes. */
  confirmedFacts: string[];
  /** Confirmed causes first, then likely ones; each carries its own label. */
  causes: DiagnosisCause[];
  /** A cause code was recorded that the registry does not word (not shown). */
  unregisteredCause: boolean;
  /** Null for a resolved incident (nothing to do). */
  operatorNext: string | null;
  attempts: { line: string; stamps: DiagnosisStamp[] };
  prior: { line: string; episodes: PriorEpisode[]; truncated: boolean };
}

const CAUSE_WORDS: Readonly<Record<string, string>> = CAUSE_CODES;

function causesOf(row: Pick<IncidentRowDTO, "causeCode" | "causeStatus">, probableCause: string | null): { causes: DiagnosisCause[]; unregistered: boolean } {
  const causes: DiagnosisCause[] = [];
  let unregistered = false;
  if (row.causeCode) {
    const words = Object.prototype.hasOwnProperty.call(CAUSE_WORDS, row.causeCode) ? CAUSE_WORDS[row.causeCode] : undefined;
    if (words) {
      causes.push(row.causeStatus === "CONFIRMED"
        ? { status: "confirmed", label: CONFIRMED_CAUSE_LABEL, text: words, source: "incident" }
        : { status: "likely", label: LIKELY_CAUSE_LABEL, text: words, source: "incident" });
    } else unregistered = true;
  }
  if (probableCause) causes.push({ status: "likely", label: LIKELY_CAUSE_LABEL, text: probableCause, source: "provider-code" });
  causes.sort((a, b) => (a.status === b.status ? 0 : a.status === "confirmed" ? -1 : 1));
  return { causes, unregistered };
}

function attemptsView(d: Pick<IncidentDetailDTO, "diagnosis" | "incident">): DiagnosisView["attempts"] {
  const a = d.diagnosis.attempts;
  const rec = d.incident.recovery;
  const line = attemptsLine(a);
  if (a && a.readable) {
    const newestSkip = a.recent.find((x) => x.status === "SKIPPED")?.at ?? null;
    return {
      line,
      stamps: [
        { label: "Last attempt", value: whenText(a.recent[0]?.at ?? null) },
        { label: "Last skip", value: whenText(newestSkip ?? rec.lastSkipAt) },
        { label: "Last success", value: whenText(a.lastSucceededAt) },
        { label: "Last failure", value: whenText(a.lastFailedAt) },
      ],
    };
  }
  // No attempts summary (not item-scoped, or unreadable): the verdict's attempt evidence, when it was read.
  if (rec.evidenceBasis === "read" && (rec.lastAttemptAt || rec.lastSkipAt)) {
    return { line, stamps: [{ label: "Last attempt", value: whenText(rec.lastAttemptAt) }, { label: "Last skip", value: whenText(rec.lastSkipAt) }] };
  }
  return { line, stamps: [] };
}

function priorView(d: Pick<IncidentDetailDTO, "diagnosis" | "incident" | "recurrences" | "related">): DiagnosisView["prior"] {
  const self = d.incident;
  const byId = new Map<string, PriorEpisode>();
  const add = (id: string, r: IncidentRowDTO | null) => {
    if (id === self.id || byId.has(id)) return;
    if (r && !(r.firstSeenAt < self.firstSeenAt)) return;
    byId.set(id, r
      ? { id, generation: r.generation, firstSeenAt: r.firstSeenAt, closedAt: r.resolvedAt, outcome: closureText(r) ?? (r.resolvedAt ? "Closed" : "Still open") }
      : { id, generation: 0, firstSeenAt: "", closedAt: null, outcome: "No longer retained" });
  };
  for (const l of d.related) if (l.kind === "PREVIOUS_EPISODE") add(l.id, l.incident);
  for (const r of d.recurrences) add(r.id, r);
  const all = [...byId.values()].sort((a, b) => (b.firstSeenAt < a.firstSeenAt ? -1 : b.firstSeenAt > a.firstSeenAt ? 1 : 0));
  const rc = d.diagnosis.recurrence;
  const newestClosed = all.find((e) => e.closedAt !== null);
  const line = newestClosed && rc.lastRecoveredAt
    ? `${recurrenceLine(rc)} · ${newestClosed.outcome.toLowerCase()}`
    : recurrenceLine(rc);
  return { line, episodes: all.slice(0, PRIOR_EPISODES_SHOWN), truncated: rc.truncated || all.length > PRIOR_EPISODES_SHOWN };
}

/** The Diagnosis section's view-model (pure over the DTO). */
export function incidentDiagnosisView(d: Pick<IncidentDetailDTO, "incident" | "summary" | "diagnosis" | "recurrences" | "related">): DiagnosisView {
  const dx = d.diagnosis;
  const code = dx.providerErrorCode;
  const ex = explainProviderError(code);
  const resolved = d.summary.displayStatus === "resolved";

  let plainEnglish = ex.plainEnglish;
  if (code && !ex.verified) plainEnglish = `${UNRECOGNISED_ERROR_TEXT.slice(0, -1)} (${code}).`;
  else if (!code && dx.providerErrorUnrecognised) plainEnglish = UNRECOGNISED_ERROR_TEXT;

  let customerStep: DiagnosisView["customerStep"] = null;
  if (ex.remedy === "customer-reconnect") customerStep = { kind: "reconnect", text: RECONNECT_ONLY_TEXT };
  else if (ex.remedy === "customer-re-add") customerStep = { kind: "re-add", text: RE_ADD_ONLY_TEXT };
  else if (!resolved && d.summary.remedy === "customer-reconnect") customerStep = { kind: "reconnect", text: NEEDS_REAUTH_TEXT };
  else if (!resolved && d.summary.remedy === "customer-re-add") customerStep = { kind: "re-add", text: RE_ADD_ONLY_TEXT };

  const { causes, unregistered } = causesOf(d.incident, ex.probableCause);

  return {
    verified: ex.verified,
    plainEnglish,
    codeLine: code ? providerCodeLine(dx) : null,
    unrecognisedNote: !code && dx.providerErrorUnrecognised ? "The recorded value isn't a known provider error code, so it isn't shown." : null,
    customerStep,
    confirmedFacts: [...ex.confirmedFacts],
    causes,
    unregisteredCause: unregistered,
    operatorNext: resolved ? null : ex.operatorNext,
    attempts: attemptsView(d),
    prior: priorView(d),
  };
}
