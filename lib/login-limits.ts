/**
 * lib/login-limits.ts  (OPS-1 S4 + Wave 2 ⑥)
 *
 * Single source of truth for the per-identifier login rate-limit window and the
 * CAPTCHA step-up threshold. Kept in its own dependency-free module so the
 * pre-login route can share these values without importing the full NextAuth
 * config (lib/auth.ts, which pulls bcrypt/email/notifications).
 *
 * The login limiter and the CAPTCHA gate deliberately share ONE fixed-window
 * bucket, keyed "login-id:<identifier>": authorize() increments it
 * (limitByKey), and both authorize() and pre-login peek it (peekKey) to decide
 * whether a CAPTCHA is required — so the widget the client shows and the token
 * the server demands stay in lock-step.
 */

/** Fixed-window length (seconds) for the per-identifier login bucket. */
export const LOGIN_ID_WINDOW_SEC = 900; // 15 min

/** Hard per-identifier attempt ceiling within the window → attempt denied. */
export const LOGIN_ID_LIMIT = 10;

/** After this many recent attempts on an identifier, a valid CAPTCHA token is
 *  required. The client shows the widget via pre-login's `captchaRequired`
 *  hint; authorize()'s server-side re-verify is the authoritative gate. */
export const LOGIN_CAPTCHA_THRESHOLD = 3;
