/**
 * lib/ai/openai-configuration.ts  (OPENAI ENVIRONMENT SEPARATION — the pure facts)
 *
 * THE VALUE-FREE DESCRIPTION OF HOW OPENAI IS CONFIGURED, computed from an env
 * map and the deployment environment it runs in. Two readers, one function:
 *
 *   · lib/ai/openai-credentials.ts refuses to build the client on any fact
 *     below that is `misconfigured`, `mismatch` or `invalid` (loud at the first
 *     call, never at import);
 *   · lib/env.ts puts the same facts in the env report the ops_env_status
 *     widget renders, so an operator sees the refusal BEFORE a customer does.
 *
 * ⚠️ ZERO IMPORTS. lib/env.ts imports this file and the credential seam imports
 * lib/env.ts, so this module must depend on neither.
 *
 * ⚠️ NEVER THE KEY, NEVER AN UNVALIDATED VALUE. The only values that leave this
 * module are a project id that MATCHES the `proj_` shape and an expected-
 * environment word that IS one of the three recognised words. A malformed
 * OPENAI_PROJECT_ID or OPENAI_EXPECTED_ENVIRONMENT is reported by STATE only —
 * a value that failed validation might be a key pasted into the wrong field,
 * and an error message or a widget is exactly where it must not appear.
 */

/** The one variable that supplies the key. There is no second name. */
export const OPENAI_API_KEY_ENV = "OPENAI_API_KEY";
/** The optional project pin, passed to the SDK's `project` option (the `OpenAI-Project` header). */
export const OPENAI_PROJECT_ID_ENV = "OPENAI_PROJECT_ID";
/** The optional environment guard: the record declares which deployment it belongs to. */
export const OPENAI_EXPECTED_ENVIRONMENT_ENV = "OPENAI_EXPECTED_ENVIRONMENT";

/** The deployment environments the guard may name — the same three words `deploymentEnvironment()` returns. */
export const OPENAI_EXPECTED_ENVIRONMENTS = ["development", "preview", "production"] as const;
export type OpenAiExpectedEnvironment = (typeof OPENAI_EXPECTED_ENVIRONMENTS)[number];

/** An OpenAI project id: `proj_` followed by letters and digits only. */
export const OPENAI_PROJECT_ID_PATTERN = /^proj_[A-Za-z0-9]+$/;

/**
 * The SHAPE of the key, never the key. `sk-proj-` is the prefix OpenAI gives a
 * project-scoped key; a bare `sk-` is a legacy user key (its usage lands in the
 * key's default project unless the `OpenAI-Project` header names one).
 */
export type OpenAiKeyKind = "project" | "legacy" | "unknown";

export interface OpenAiProjectPinFact {
  state: "pinned" | "unpinned" | "misconfigured";
  /** The validated project id (a non-secret identifier, shown in full), or null. */
  projectId: string | null;
}

export interface OpenAiExpectedEnvironmentFact {
  state: "unset" | "match" | "mismatch" | "invalid";
  /** The validated expected-environment word, or null when unset or invalid. */
  expected: OpenAiExpectedEnvironment | null;
  /** The deployment environment this process classified itself as. */
  actual: OpenAiExpectedEnvironment;
}

export interface OpenAiConfigurationFacts {
  /** Whether OPENAI_API_KEY is set (presence only). */
  keyConfigured: boolean;
  keyKind: OpenAiKeyKind;
  projectPin: OpenAiProjectPinFact;
  expectedEnvironment: OpenAiExpectedEnvironmentFact;
  /**
   * True when the credential seam would refuse to build the client: a malformed
   * pin, an invalid guard value, or a guard that names another environment.
   * An ABSENT key is not a refusal of this kind (it is the ordinary "AI not
   * configured" state), so it is reported through `keyConfigured` instead.
   */
  refused: boolean;
}

/** A minimal env map: the SUBSET of `NodeJS.ProcessEnv` this module reads. */
export type OpenAiEnvMap = Readonly<Record<string, string | undefined>>;

export function isOpenAiExpectedEnvironment(value: string): value is OpenAiExpectedEnvironment {
  return (OPENAI_EXPECTED_ENVIRONMENTS as readonly string[]).includes(value);
}

export function classifyOpenAiKey(apiKey: string | undefined): OpenAiKeyKind {
  if (!apiKey) return "unknown";
  if (apiKey.startsWith("sk-proj-")) return "project";
  if (apiKey.startsWith("sk-")) return "legacy";
  return "unknown";
}

export function describeOpenAiProjectPin(env: OpenAiEnvMap): OpenAiProjectPinFact {
  const raw = env[OPENAI_PROJECT_ID_ENV]?.trim() ?? "";
  if (raw === "") return { state: "unpinned", projectId: null };
  if (OPENAI_PROJECT_ID_PATTERN.test(raw)) return { state: "pinned", projectId: raw };
  return { state: "misconfigured", projectId: null };
}

export function describeOpenAiExpectedEnvironment(
  env: OpenAiEnvMap,
  actual: OpenAiExpectedEnvironment,
): OpenAiExpectedEnvironmentFact {
  const raw = env[OPENAI_EXPECTED_ENVIRONMENT_ENV]?.trim() ?? "";
  if (raw === "") return { state: "unset", expected: null, actual };
  if (!isOpenAiExpectedEnvironment(raw)) return { state: "invalid", expected: null, actual };
  return { state: raw === actual ? "match" : "mismatch", expected: raw, actual };
}

/** The whole value-free picture. Pure: same inputs, same facts; reads nothing but its arguments. */
export function describeOpenAiConfiguration(env: OpenAiEnvMap, actual: OpenAiExpectedEnvironment): OpenAiConfigurationFacts {
  const apiKey = env[OPENAI_API_KEY_ENV];
  const projectPin = describeOpenAiProjectPin(env);
  const expectedEnvironment = describeOpenAiExpectedEnvironment(env, actual);
  return {
    keyConfigured: !!apiKey,
    keyKind: classifyOpenAiKey(apiKey),
    projectPin,
    expectedEnvironment,
    refused:
      projectPin.state === "misconfigured" ||
      expectedEnvironment.state === "invalid" ||
      expectedEnvironment.state === "mismatch",
  };
}
