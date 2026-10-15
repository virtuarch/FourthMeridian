/**
 * lib/ai/openai-credentials.ts  (OPENAI ENVIRONMENT SEPARATION — the credential seam)
 *
 * THE ONE PLACE THE OPENAI CLIENT'S CREDENTIALS ARE RESOLVED. `lib/ai/provider.ts`
 * (the only OpenAI SDK import site) calls `resolveOpenAiCredentials()` when it
 * first builds its client and nowhere else reads the key.
 *
 * ⚠️ NO FALLBACK ACROSS NAMES OR ENVIRONMENTS. Exactly one variable supplies
 * the key (`OPENAI_API_KEY`) and exactly one supplies the optional project pin
 * (`OPENAI_PROJECT_ID`). There is no `|| process.env.OTHER_KEY`, no per-
 * environment suffix, no default. Each Vercel environment (Development,
 * Preview, Production) carries its own record of the same name, so the only
 * way Preview can spend from the Production project is for the owner to paste
 * the same key into both records — which this module cannot see and the
 * verification runbook (docs/operations/openai-environment-separation.md) is for.
 *
 * ⚠️ FAILS CLOSED BEFORE ANY CALL (Agent C, AI COST CONTROLS). Three refusals,
 * all loud at the first call and never at import:
 *   (a) OPENAI_PROJECT_ID set but not `proj_` + [A-Za-z0-9]  ⇒ refuse;
 *   (b) OPENAI_EXPECTED_ENVIRONMENT set but not one of development | preview |
 *       production                                               ⇒ refuse;
 *   (c) OPENAI_EXPECTED_ENVIRONMENT set and ≠ `deploymentEnvironment()` ⇒ refuse.
 * (c) is the lever against "a record copied to the wrong environment": the
 * owner sets OPENAI_EXPECTED_ENVIRONMENT=preview beside the Preview project's
 * key and =production beside the Production project's key, and a record that
 * lands on the other environment is refused before the provider is reached.
 * The guard is OPTIONAL so an unset environment (local dev, CI, tests) is
 * byte-identical to before.
 *
 * ⚠️ NO VALUE EVER LEAVES IN AN ERROR. Messages name the variable and the
 * state; never the key, never a value that failed validation (a malformed
 * "project id" might be a key pasted into the wrong field). The only values a
 * message may carry are the two validated environment words.
 *
 * PURE over an env map and an environment word; the defaults are the process
 * env and `deploymentEnvironment()`, so the provider's existing call site
 * (`resolveOpenAiCredentials()` with no arguments) needed no change.
 */

import { deploymentEnvironment } from "@/lib/env";
import {
  describeOpenAiConfiguration,
  OPENAI_API_KEY_ENV,
  OPENAI_EXPECTED_ENVIRONMENT_ENV,
  OPENAI_EXPECTED_ENVIRONMENTS,
  OPENAI_PROJECT_ID_ENV,
  type OpenAiConfigurationFacts,
  type OpenAiEnvMap,
  type OpenAiExpectedEnvironment,
  type OpenAiKeyKind,
} from "@/lib/ai/openai-configuration";

export interface OpenAiCredentials {
  apiKey: string;
  /** The OpenAI project id (`proj_…`) the client is pinned to, or null when unpinned. */
  project: string | null;
  /** The SHAPE of the key (`sk-proj-` ⇒ project key), never the key. */
  keyKind: OpenAiKeyKind;
}

export class OpenAiCredentialsError extends Error {
  constructor(message: string) { super(message); this.name = "OpenAiCredentialsError"; }
}

/**
 * Resolve the credentials the provider client is built with. Throws when the key
 * is absent, the project pin is malformed, or the environment guard is invalid
 * or names another environment (loud at first call, never at import).
 *
 * @param env         The env map to read (defaults to `process.env`).
 * @param environment The deployment environment this process is (defaults to
 *                    `deploymentEnvironment()`); compared against the guard.
 */
export function resolveOpenAiCredentials(
  env: OpenAiEnvMap = process.env,
  environment: OpenAiExpectedEnvironment = deploymentEnvironment(),
): OpenAiCredentials {
  const facts = describeOpenAiConfiguration(env, environment);
  const refusal = refusalFor(facts);
  if (refusal) throw new OpenAiCredentialsError(refusal);

  const apiKey = env[OPENAI_API_KEY_ENV];
  if (!apiKey) {
    throw new OpenAiCredentialsError(
      `[ai/provider] ${OPENAI_API_KEY_ENV} is not set. ` +
      "Add it to .env.local for local development and to your Vercel " +
      "environment variables for deployed environments.",
    );
  }
  return { apiKey, project: facts.projectPin.projectId, keyKind: facts.keyKind };
}

/**
 * The refusal sentence for a set of facts, or null when the facts admit a
 * client. Shared with nothing that prints values: every branch names a variable
 * and a state, and the only interpolated values are validated environment words.
 */
export function refusalFor(facts: OpenAiConfigurationFacts): string | null {
  if (facts.expectedEnvironment.state === "invalid") {
    return (
      `[ai/provider] ${OPENAI_EXPECTED_ENVIRONMENT_ENV} is set to an unrecognised value ` +
      `(expected one of ${OPENAI_EXPECTED_ENVIRONMENTS.join(" | ")}); refusing to build the OpenAI client. ` +
      "The value is not shown here. Fix the record on this deployment's environment or remove the variable."
    );
  }
  if (facts.expectedEnvironment.state === "mismatch") {
    return (
      `[ai/provider] ${OPENAI_EXPECTED_ENVIRONMENT_ENV} says "${facts.expectedEnvironment.expected}" ` +
      `but this is a "${facts.expectedEnvironment.actual}" deployment; refusing to build the OpenAI client. ` +
      "This record belongs to another environment — the key beside it is not used. " +
      "Put each project's key, project id and expected environment on that environment's own record."
    );
  }
  if (facts.projectPin.state === "misconfigured") {
    return (
      `[ai/provider] ${OPENAI_PROJECT_ID_ENV} is set but is not an OpenAI project id ` +
      "(expected proj_ followed by letters and digits); refusing to build the OpenAI client. " +
      "The value is not shown here. Copy the project id from platform.openai.com → Settings → Projects, or remove the variable to run unpinned."
    );
  }
  return null;
}
