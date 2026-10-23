/**
 * lib/plaid/webhook-migration.core.ts  (Release 2 — domain split)
 *
 * PURE decisions for moving an existing Plaid Item's webhook URL to the app's
 * own origin. No I/O, no env, no Plaid — so every refusal is unit-tested.
 *
 * WHY THIS EXISTS: Plaid stores the webhook URL PER ITEM, fixed at link time
 * from NEXT_PUBLIC_APP_URL. Items linked while the app served the apex keep
 * POSTing to https://fourthmeridian.com/api/plaid/webhook after the apex
 * becomes the static public site (404 there). /item/webhook/update is Plaid's
 * supported way to repoint an existing Item; Plaid then sends
 * ITEM / WEBHOOK_UPDATE_ACKNOWLEDGED to the NEW URL, which is the delivery
 * proof.
 *
 * THE TARGET IS NEVER CALLER-SUPPLIED. It is derived from the deployment's own
 * trusted base URL — the same source link-token creation uses for new Items —
 * so this tool can only ever point an Item at the app that is running it.
 * Rollback is therefore "revert NEXT_PUBLIC_APP_URL, redeploy, run again":
 * the same code path, never a free-text URL.
 */

export const PLAID_WEBHOOK_PATH = "/api/plaid/webhook";

/** Item statuses whose webhook may be repointed. REVOKED Items have no live token. */
export const WEBHOOK_MIGRATABLE_STATUSES: ReadonlySet<string> = new Set(["ACTIVE", "NEEDS_REAUTH"]);

/**
 * The webhook URL this deployment should own: `${appUrl}/api/plaid/webhook`,
 * or null when the base is not a public HTTPS origin (local dev, http, or a
 * malformed value) — the tool then refuses rather than writing an unusable URL.
 */
export function expectedWebhookUrl(appUrl: string | undefined | null): string | null {
  const raw = appUrl?.trim();
  if (!raw) return null;
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== "https:") return null;
  if (/^(localhost|127\.0\.0\.1|\[::1\])$/i.test(u.hostname)) return null;
  if (u.username || u.password || u.search || u.hash) return null;
  const base = `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
  return `${base}${PLAID_WEBHOOK_PATH}`;
}

/**
 * Origin + path only — never a query string (Plaid webhook URLs carry no secret,
 * but a hand-registered one could). Null/empty ⇒ null. Unparseable ⇒ "<invalid>".
 */
export function redactWebhookUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return "<invalid>";
  }
}

export type WebhookMigrationAction = "UPDATE" | "ALREADY_CURRENT" | "SKIP_STATUS" | "NO_TARGET";

export interface WebhookMigrationPlan {
  action: WebhookMigrationAction;
  current: string | null;
  target: string | null;
  reason: string;
}

/** What the tool would do for one Item. Comparison is on the exact stored URL. */
export function planWebhookMigration(input: {
  status: string;
  currentWebhook: string | null;
  target: string | null;
}): WebhookMigrationPlan {
  const current = redactWebhookUrl(input.currentWebhook);
  const target = input.target;
  if (!target) {
    return { action: "NO_TARGET", current, target: null, reason: "This deployment has no public HTTPS app URL to point webhooks at." };
  }
  if (!WEBHOOK_MIGRATABLE_STATUSES.has(input.status)) {
    return { action: "SKIP_STATUS", current, target, reason: `Item status ${input.status} has no usable access token.` };
  }
  if (input.currentWebhook === target) {
    return { action: "ALREADY_CURRENT", current, target, reason: "The Item already delivers webhooks to this app." };
  }
  return { action: "UPDATE", current, target, reason: "The Item delivers webhooks elsewhere; repoint it to this app." };
}
