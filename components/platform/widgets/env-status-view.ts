/**
 * components/platform/widgets/env-status-view.ts  (OPENAI ENVIRONMENT SEPARATION)
 *
 * THE PURE VIEW-MODEL behind the "OpenAI project pin" block of the
 * ops_env_status widget. Three lines, each a word the env report said:
 *
 *   OpenAI key          not set · project key · legacy user key · unrecognised shape
 *   Project pin         pinned proj_… (the id in full — a non-secret identifier)
 *                       · unpinned · misconfigured
 *   Environment guard   match (preview) · unset · mismatch (says X, this is Y) · invalid
 *
 * No React, no fetch, no clock, and NEVER a value: the report already carries
 * only validated identifiers, and this module adds nothing to them.
 */

import type { OpenAiConfigurationFacts } from "@/lib/ai/openai-configuration";
import type { StatusTone } from "../platform-surface";

export interface EnvFactLine {
  label: string;
  value: string;
  tone: StatusTone;
}

const KEY_WORD: Record<OpenAiConfigurationFacts["keyKind"], string> = {
  project: "project key",
  legacy:  "legacy user key",
  unknown: "unrecognised shape",
};

export function openAiKeyLine(f: OpenAiConfigurationFacts): EnvFactLine {
  if (!f.keyConfigured) return { label: "OpenAI key", value: "not set — AI disabled", tone: "warn" };
  return { label: "OpenAI key", value: KEY_WORD[f.keyKind], tone: f.keyKind === "project" ? "ok" : "warn" };
}

export function openAiProjectPinLine(f: OpenAiConfigurationFacts): EnvFactLine {
  const p = f.projectPin;
  if (p.state === "pinned") return { label: "Project pin", value: `pinned · ${p.projectId}`, tone: "ok" };
  if (p.state === "unpinned") return { label: "Project pin", value: "unpinned — usage lands in the key's own project", tone: "warn" };
  return { label: "Project pin", value: "misconfigured — not a proj_ id; AI calls refused", tone: "bad" };
}

export function openAiExpectedEnvironmentLine(f: OpenAiConfigurationFacts): EnvFactLine {
  const g = f.expectedEnvironment;
  switch (g.state) {
    case "match":    return { label: "Environment guard", value: `match · ${g.expected}`, tone: "ok" };
    case "unset":    return { label: "Environment guard", value: "unset — a copied record would be accepted", tone: "warn" };
    case "mismatch": return { label: "Environment guard", value: `mismatch — says ${g.expected}, this is ${g.actual}; AI calls refused`, tone: "bad" };
    case "invalid":  return { label: "Environment guard", value: "invalid — unrecognised value; AI calls refused", tone: "bad" };
  }
}

/** The three lines, in display order. */
export function openAiFactLines(f: OpenAiConfigurationFacts): EnvFactLine[] {
  return [openAiKeyLine(f), openAiProjectPinLine(f), openAiExpectedEnvironmentLine(f)];
}

/** The block's one-word verdict: the worst tone among its lines. */
export function openAiBlockTone(f: OpenAiConfigurationFacts): StatusTone {
  const tones = openAiFactLines(f).map((l) => l.tone);
  if (tones.includes("bad")) return "bad";
  if (tones.includes("warn")) return "warn";
  return "ok";
}
