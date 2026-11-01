/**
 * lib/captcha.ts  (Wave 1 S3 — shipped here so Wave 2 ⑥ only consumes it;
 * R2 beta-intake hardening 2026-10-31 — fail CLOSED when configured;
 * R2 follow-up 2026-11-01 — fail CLOSED on missing config IN PRODUCTION, and a
 * stricter siteverify check)
 *
 * Server-side CAPTCHA (Cloudflare Turnstile) verification, behind a single
 * helper so every spam-exposed endpoint calls one thing: `verifyCaptchaToken`.
 * Callers (all share these semantics — keep them consistent), each with its
 * own Turnstile ACTION (set on its widget, required back from siteverify):
 *   - app/api/access-request/route.ts  — every submission           "access_request"
 *   - app/api/auth/register/route.ts   — every registration         "register"
 *   - lib/auth.ts authorize()          — login step-up past the     "login"
 *                                        per-identifier failure threshold
 *
 * MODES — `resolveCaptchaConfig(env)`, a PURE function of an env object (read
 * per call, never cached, so setting keys later takes effect with no code
 * change). "Production" means VERCEL_ENV === "production" exactly.
 *
 *   "enforced" — TURNSTILE_SECRET_KEY is set (and, in Production, the site key
 *     too). A token is verified against Cloudflare's siteverify endpoint.
 *
 *   "not_configured" — OUTSIDE PRODUCTION ONLY (preview / development / local /
 *     tests) with no secret. Verification is SKIPPED and returns "passed" with
 *     no network call, with one warning per process. Deliberate: local dev and
 *     Preview keep working until keys have been validated there (owner, 11-01).
 *
 *   "misconfigured" — PRODUCTION with the secret missing, or with exactly one
 *     of NEXT_PUBLIC_TURNSTILE_SITE_KEY / TURNSTILE_SECRET_KEY set. FAILS
 *     CLOSED: the verdict is "unavailable" (no network call), logged once per
 *     process as an error. lib/env.ts validateEnv() also logs the pairing.
 *
 * VERDICTS — only "passed" may proceed:
 *   "passed"      — skipped (not_configured), or Cloudflare positively
 *                   confirmed the token AND the reply passed the strict checks.
 *   "rejected"    — the CHALLENGE failed: missing/empty token, `success: false`,
 *                   or a `success: true` reply whose `hostname` is not in the
 *                   allowlist, whose `action` is missing or not the caller's,
 *                   or whose `challenge_ts` is missing or older than
 *                   CHALLENGE_MAX_AGE_SEC. Callers answer with their ordinary
 *                   400 / denied login.
 *   "unavailable" — misconfigured Production, non-2xx from Cloudflare, network
 *                   error, timeout (VERIFY_TIMEOUT_MS) or a malformed reply. We
 *                   could not CONSULT the authority: callers answer honestly
 *                   with "temporarily unavailable" (503 + Retry-After on the
 *                   routes, the AUTH_UNAVAILABLE_TOKEN sentinel in authorize()).
 *
 * HOSTNAME ALLOWLIST (`captchaAllowedHostnames(env)`): the hosts of
 * NEXT_PUBLIC_APP_URL and NEXT_PUBLIC_SITE_URL (when set and parseable) plus
 * the comma-separated TURNSTILE_ALLOWED_HOSTNAMES (exact hostnames, e.g.
 * "www.fourthmeridian.com"). Compared case-insensitively, exactly — no
 * wildcards. An EMPTY allowlist skips the hostname check outside Production
 * (warned once) and is "misconfigured" ⇒ "unavailable" in Production.
 *
 * WHY FAIL CLOSED (owner decision, R2): a fail-open posture means a bot only
 * has to wait for — or induce — a siteverify error, or find a deploy without
 * keys, to bypass the challenge. The cost is accepted: during a Cloudflare
 * outage, or while Production lacks keys, CAPTCHA-gated actions (access
 * requests, registrations, step-up logins past the failure threshold) are
 * refused as "temporarily unavailable". Ordinary logins below the step-up
 * threshold never call this and are unaffected.
 *
 * NO SDK: Turnstile verification is one POST to a documented URL, so there is no
 * import to isolate — the single-import-site house rule is satisfied by having
 * no import at all.
 */

import "server-only";

/** Cloudflare Turnstile server-side verification endpoint. */
const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/** How long to wait on Cloudflare before failing CLOSED (ms). */
export const VERIFY_TIMEOUT_MS = 5_000;

/** Oldest accepted challenge (seconds; Turnstile tokens themselves live 300 s). */
export const CHALLENGE_MAX_AGE_SEC = 300;

/** The Turnstile action each surface sets on its widget and requires back. */
export const CAPTCHA_ACTIONS = {
  accessRequest: "access_request",
  register:      "register",
  login:         "login",
} as const;
export type CaptchaAction = typeof CAPTCHA_ACTIONS[keyof typeof CAPTCHA_ACTIONS];

/** The subset of the siteverify JSON response we read. */
interface SiteverifyResponse {
  success?: unknown;
  hostname?: unknown;
  action?: unknown;
  challenge_ts?: unknown;
  "error-codes"?: string[];
}

/** The env keys this module reads (a plain object, so tests pass their own). */
export interface CaptchaEnv {
  [key: string]: string | undefined;
  VERCEL_ENV?: string;
  TURNSTILE_SECRET_KEY?: string;
  NEXT_PUBLIC_TURNSTILE_SITE_KEY?: string;
  NEXT_PUBLIC_APP_URL?: string;
  NEXT_PUBLIC_SITE_URL?: string;
  TURNSTILE_ALLOWED_HOSTNAMES?: string;
}

export type CaptchaMode = "enforced" | "not_configured" | "misconfigured";

export type CaptchaConfig =
  | { mode: "enforced"; secret: string; allowedHostnames: string[]; production: boolean }
  | { mode: "not_configured"; reason: string }
  | { mode: "misconfigured"; reason: string };

/** The verification verdict. Only "passed" may proceed (see header). */
export type CaptchaVerdict = "passed" | "rejected" | "unavailable";

/** Generic copy for the "unavailable" verdict on the public routes (503). */
export const CAPTCHA_UNAVAILABLE_MESSAGE =
  "Verification is temporarily unavailable. Please try again in a few minutes.";

function hostOf(url: string | undefined): string | null {
  if (!url || !url.trim()) return null;
  try { return new URL(url.trim()).hostname.toLowerCase() || null; } catch { return null; }
}

/** PURE: the hostnames a successful siteverify reply may name (see header). */
export function captchaAllowedHostnames(env: CaptchaEnv): string[] {
  const out = new Set<string>();
  for (const u of [env.NEXT_PUBLIC_APP_URL, env.NEXT_PUBLIC_SITE_URL]) {
    const h = hostOf(u);
    if (h) out.add(h);
  }
  for (const raw of (env.TURNSTILE_ALLOWED_HOSTNAMES ?? "").split(",")) {
    const h = raw.trim().toLowerCase();
    if (h) out.add(h);
  }
  return [...out];
}

/** PURE: the CAPTCHA mode for an env object (see header for the matrix). */
export function resolveCaptchaConfig(env: CaptchaEnv): CaptchaConfig {
  const production = env.VERCEL_ENV === "production";
  const secret = env.TURNSTILE_SECRET_KEY || "";
  const site = env.NEXT_PUBLIC_TURNSTILE_SITE_KEY || "";
  const allowedHostnames = captchaAllowedHostnames(env);
  if (production) {
    if (!secret && !site) return { mode: "misconfigured", reason: "TURNSTILE_SECRET_KEY and NEXT_PUBLIC_TURNSTILE_SITE_KEY are not set in Production" };
    if (!secret) return { mode: "misconfigured", reason: "NEXT_PUBLIC_TURNSTILE_SITE_KEY is set but TURNSTILE_SECRET_KEY is not in Production" };
    if (!site) return { mode: "misconfigured", reason: "TURNSTILE_SECRET_KEY is set but NEXT_PUBLIC_TURNSTILE_SITE_KEY is not in Production" };
    if (allowedHostnames.length === 0) return { mode: "misconfigured", reason: "no allowed hostname in Production (set NEXT_PUBLIC_APP_URL / NEXT_PUBLIC_SITE_URL / TURNSTILE_ALLOWED_HOSTNAMES)" };
    return { mode: "enforced", secret, allowedHostnames, production };
  }
  if (!secret) {
    return { mode: "not_configured", reason: site
      ? "NEXT_PUBLIC_TURNSTILE_SITE_KEY is set but TURNSTILE_SECRET_KEY is not (outside Production) — tokens are NOT verified"
      : "TURNSTILE_SECRET_KEY not set (outside Production) — CAPTCHA verification is NOT enforced (requests pass unchallenged)" };
  }
  return { mode: "enforced", secret, allowedHostnames, production };
}

/** Whether server-side CAPTCHA verification is enforced on this deploy (reads env per call). */
export function captchaMode(env: CaptchaEnv = process.env): CaptchaMode {
  return resolveCaptchaConfig(env).mode;
}

const logged = new Set<string>();
/** Log each distinct configuration message once per process. */
function logOnce(level: "warn" | "error" | "log", msg: string): void {
  if (logged.has(msg)) return;
  logged.add(msg);
  console[level](msg);
}

function logConfig(cfg: CaptchaConfig, env: CaptchaEnv): void {
  if (cfg.mode === "not_configured") logOnce("warn", `[captcha] ${cfg.reason}`);
  else if (cfg.mode === "misconfigured") logOnce("error", `[captcha] MISCONFIGURED — ${cfg.reason}; every CAPTCHA-gated request (access request, registration, step-up login) is REFUSED as unavailable`);
  else if (!env.NEXT_PUBLIC_TURNSTILE_SITE_KEY) {
    // A secret without a site key means the widget is never rendered, so no
    // client can produce a token and every gated request will be refused.
    logOnce("error", "[captcha] TURNSTILE_SECRET_KEY is set but NEXT_PUBLIC_TURNSTILE_SITE_KEY is not — every CAPTCHA-gated request will be refused");
  } else {
    if (cfg.allowedHostnames.length === 0) logOnce("warn", "[captcha] no allowed hostname configured (outside Production) — the siteverify hostname is NOT checked");
    logOnce("log", "[captcha] Turnstile verification enforced (fail-closed)");
  }
}

/**
 * PURE: judge a 2xx siteverify reply. "unavailable" for a malformed reply,
 * "rejected" for a failed challenge or a success that fails the strict
 * hostname / action / age checks, "passed" otherwise.
 */
export function judgeSiteverifyReply(
  data: unknown,
  expect: { action: CaptchaAction; allowedHostnames: string[]; now?: Date },
): { verdict: CaptchaVerdict; reason?: string } {
  if (!data || typeof data !== "object" || typeof (data as SiteverifyResponse).success !== "boolean") {
    return { verdict: "unavailable", reason: "reply has no boolean `success`" };
  }
  const d = data as SiteverifyResponse;
  if (!d.success) return { verdict: "rejected", reason: "success:false" };

  if (expect.allowedHostnames.length > 0) {
    const host = typeof d.hostname === "string" ? d.hostname.trim().toLowerCase() : "";
    if (!host || !expect.allowedHostnames.includes(host)) {
      return { verdict: "rejected", reason: `hostname ${JSON.stringify(d.hostname ?? null)} not allowed` };
    }
  }
  if (d.action !== expect.action) {
    return { verdict: "rejected", reason: `action ${JSON.stringify(d.action ?? null)} ≠ ${JSON.stringify(expect.action)}` };
  }
  const ts = typeof d.challenge_ts === "string" ? Date.parse(d.challenge_ts) : NaN;
  if (!Number.isFinite(ts)) return { verdict: "rejected", reason: "challenge_ts missing or unparseable" };
  const ageSec = ((expect.now ?? new Date()).getTime() - ts) / 1000;
  if (ageSec > CHALLENGE_MAX_AGE_SEC) return { verdict: "rejected", reason: `challenge is ${Math.round(ageSec)}s old` };
  return { verdict: "passed" };
}

export interface VerifyCaptchaOptions {
  /** The surface's Turnstile action — REQUIRED back from siteverify. */
  action: CaptchaAction;
  /** The caller's IP (Cloudflare's `remoteip`), best-effort. */
  ip?: string;
  /** Timeout override (tests). */
  timeoutMs?: number;
  /** Env override (tests); defaults to process.env, read per call. */
  env?: CaptchaEnv;
  /** Clock override (tests). */
  now?: Date;
}

/**
 * Verify a Turnstile token.
 *
 * @param token  The `cf-turnstile-response` value posted by the widget. May be
 *               empty/absent — "rejected" when enforced, ignored when not
 *               configured.
 * @returns      See the VERDICTS section of the header. Only "passed" may proceed.
 */
export async function verifyCaptchaToken(
  token: string | undefined | null,
  opts: VerifyCaptchaOptions,
): Promise<CaptchaVerdict> {
  const env = opts.env ?? process.env;
  const cfg = resolveCaptchaConfig(env);
  logConfig(cfg, env);
  if (cfg.mode === "not_configured") return "passed";
  if (cfg.mode === "misconfigured") return "unavailable";

  // An enforced CAPTCHA with no token is a failed challenge.
  if (!token) return "rejected";

  let res: Response;
  try {
    const form = new URLSearchParams();
    form.set("secret", cfg.secret);
    form.set("response", token);
    if (opts.ip) form.set("remoteip", opts.ip);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? VERIFY_TIMEOUT_MS);
    try {
      res = await fetch(SITEVERIFY_URL, {
        method:  "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body:    form.toString(),
        signal:  controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    // Network error / abort (timeout) — fail CLOSED as unavailable.
    console.error("[captcha] siteverify call failed — failing CLOSED (unavailable):", err instanceof Error ? err.message : err);
    return "unavailable";
  }

  if (!res.ok) {
    console.error(`[captcha] siteverify HTTP ${res.status} — failing CLOSED (unavailable)`);
    return "unavailable";
  }

  let data: unknown;
  try {
    data = await res.json();
  } catch {
    console.error("[captcha] siteverify returned malformed JSON — failing CLOSED (unavailable)");
    return "unavailable";
  }
  const judged = judgeSiteverifyReply(data, { action: opts.action, allowedHostnames: cfg.allowedHostnames, now: opts.now });
  if (judged.verdict === "unavailable") console.error(`[captcha] siteverify ${judged.reason} — failing CLOSED (unavailable)`);
  else if (judged.verdict === "rejected" && judged.reason !== "success:false") console.warn(`[captcha] siteverify success rejected: ${judged.reason}`);
  return judged.verdict;
}
