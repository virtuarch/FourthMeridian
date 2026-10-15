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
 * verification runbook (Agent C) is for.
 *
 * PURE over an env map; never prints or returns anything but what it was given.
 * Agent C extends this module (project-pin validation, the value-free report).
 */

export interface OpenAiCredentials {
  apiKey: string;
  /** The OpenAI project id (`proj_…`) the client is pinned to, or null when unpinned. */
  project: string | null;
}

export class OpenAiCredentialsError extends Error {
  constructor(message: string) { super(message); this.name = "OpenAiCredentialsError"; }
}

/** Resolve the credentials the provider client is built with. Throws when the key is absent (loud at first call, never at import). */
export function resolveOpenAiCredentials(env: NodeJS.ProcessEnv = process.env): OpenAiCredentials {
  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new OpenAiCredentialsError(
      "[ai/provider] OPENAI_API_KEY is not set. " +
      "Add it to .env.local for local development and to your Vercel " +
      "environment variables for deployed environments.",
    );
  }
  const project = env.OPENAI_PROJECT_ID?.trim() || null;
  return { apiKey, project };
}
