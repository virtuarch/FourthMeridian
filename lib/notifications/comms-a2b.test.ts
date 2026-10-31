/**
 * lib/notifications/comms-a2b.test.ts  (Comms Center Phase A-2b — owner decisions)
 *
 * Behavioural proof of the four owner decisions, against the REAL
 * createNotification, preference resolver, sendEmail chokepoint, storm
 * decision and anomaly payload builders — with in-memory fakes for the
 * database, provider and ledger (no DB, no network, no email).
 *
 *   1. O-8  the Security Ops bell cannot be muted by ANY preference combination.
 *   2. O-8  no plaintext login identifier / IP in the bell's dedupe key or
 *           metadata; dedupe still works (same identifier ⇒ same hash).
 *   3. O-7  (owner ruling 2026-10-31) FINANCIAL in-app off + email on ⇒ the
 *           connection-failure email is sent; email off ⇒ suppressed, reason
 *           recorded. One email per outage, retirement re-arms it.
 *   4. O-10 6th customer email in an hour ⇒ SUPPRESSED RATE_LIMITED, recorded,
 *           never sent; security / ceremony exempt; an unreadable count ⇒
 *           limited mail suppressed RATE_LIMIT_UNVERIFIED, exempt mail sent.
 *   5. the catalog reflects every change.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/notifications/comms-a2b.test.ts
 */

import { readFileSync } from "node:fs";
import { createEmailSender, type EmailSendEnv } from "@/lib/email/send";
import type { EmailMessage, EmailProvider, EmailResult } from "@/lib/email/types";
import { createHmac } from "node:crypto";
import { createNotification, fillDedupeTemplate, type NotificationWriteClient } from "@/lib/notifications/create";
import { EMAIL_ANCHOR_MARKER, isEmailAnchorMetadata } from "@/lib/notifications/email-anchor";
import { MAX_DELIVERY_ATTEMPTS, retryNotifications, type NotificationRetryClient } from "@/jobs/retry-notifications";
import { retireOpenNotification, type NotificationResolveClient } from "@/lib/notifications/resolve";
import {
  PREFERENCE_CATEGORIES,
  PREFERENCE_CHANNELS,
  resolveChannelEnabled,
  type PreferenceClient,
  type PreferenceOverride,
} from "@/lib/notifications/preferences";
import { NOTIFICATION_REGISTRY, NOTIFICATION_TYPE_IDS } from "@/lib/notifications/registry";
import type { ChannelAdapter, NotificationTypeDefinition } from "@/lib/notifications/types";
import {
  CATALOG_KEYS,
  COMMS_CATALOG,
  EMAIL_STORM_LIMIT,
  EMAIL_STORM_LIMITED_CLASSES,
  GLOBAL_EMAIL_CAP_PER_HOUR,
  KNOWN_PII_DEDUPE_KEYS,
  KNOWN_SUPPRESSIBILITY_GAPS,
  isStormLimitedKey,
} from "@/lib/notifications/catalog/definitions";
import { decideStorm, PendingSends, type StormCounter } from "@/lib/notifications/delivery/storm";
import { SUPPRESSION_REASONS, type CommsDeliveryRow, type LedgerWriter } from "@/lib/notifications/delivery/types";
import { FALLBACK_SALT_LABEL, hashSecurityIdentifier, hashedAnomalyKey, isHashedAnomalyKey } from "@/lib/security/identifier-hash";
import { anomalyAuditMetadata, anomalyNotificationData } from "@/lib/security/anomaly-alerts";
import { detectIdentifierAnomalies, detectIpAnomaly, detectSystemAdminAnomaly } from "@/lib/security/anomalies";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
  }
}

const NOW = new Date("2026-10-31T12:00:00.000Z");
const ADDRESS = "Person.Private@example.invalid";

// ── An in-memory Notification store (create + dedupe + retire) ────────────────

interface Row { id: string; userId: string; dedupeKey: string | null; archivedAt: Date | null; metadata: unknown; category: string; type: string; priority: string; title: string; body: string | null; href: string | null }
interface DeliveryRow { id: string; notificationId: string; channel: string; status: string; attempts: number; provider: string | null; error: string | null }

function store() {
  const rows: Row[] = [];
  const deliveries: DeliveryRow[] = [];
  let n = 0;
  const client: NotificationWriteClient = {
    user: { async findUnique() { return { email: ADDRESS }; } },
    notificationDelivery: { async create({ data }) { const d = { ...data, id: `d${deliveries.length + 1}` }; deliveries.push(d); return { id: d.id }; } },
    notification: {
      async create({ data }) {
        if (data.dedupeKey !== null && rows.some((r) => r.userId === data.userId && r.dedupeKey === data.dedupeKey)) {
          throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
        }
        const row: Row = { id: `n${++n}`, userId: data.userId, dedupeKey: data.dedupeKey, archivedAt: data.archivedAt ?? null, metadata: data.metadata, category: data.category,
          type: data.type, priority: data.priority, title: data.title, body: data.body, href: data.href };
        rows.push(row);
        return { id: row.id };
      },
      async findUnique({ where }) {
        const r = rows.find((x) => x.userId === where.userId_dedupeKey.userId && x.dedupeKey === where.userId_dedupeKey.dedupeKey);
        return r ? { id: r.id, archivedAt: r.archivedAt, metadata: r.metadata } : null;
      },
      async update({ where, data }) {
        const r = rows.find((x) => x.id === where.id);
        if (r) r.dedupeKey = data.dedupeKey;
        return { id: where.id };
      },
    },
  };
  const resolveClient: NotificationResolveClient = {
    notification: {
      async updateMany(args) {
        const wantOpen = args.where.archivedAt === null;
        const hit = rows.filter((r) => r.userId === args.where.userId && r.dedupeKey === args.where.dedupeKey && (wantOpen ? r.archivedAt === null : r.archivedAt !== null));
        for (const r of hit) { r.dedupeKey = null; if ("archivedAt" in args.data) r.archivedAt = args.data.archivedAt; }
        return { count: hit.length };
      },
    },
  };
  /** The retry job's client over the same rows (jobs/retry-notifications.ts). */
  const retryClient: NotificationRetryClient = {
    notificationDelivery: {
      async findMany({ where }) {
        return deliveries.filter((d) => d.channel === where.channel && d.status === where.status && d.attempts < where.attempts.lt).map((d) => {
          const r = rows.find((x) => x.id === d.notificationId) ?? null;
          return {
            id: d.id, attempts: d.attempts, notificationId: d.notificationId,
            notification: r && { userId: r.userId, type: r.type, category: r.category, priority: r.priority, title: r.title, body: r.body, href: r.href,
              metadata: r.metadata, readAt: null, archivedAt: r.archivedAt, expiresAt: null, dedupeKey: r.dedupeKey, user: { email: ADDRESS } },
          };
        });
      },
      async updateMany({ where }) {
        const d = deliveries.find((x) => x.id === where.id && x.status === where.status && x.attempts === where.attempts);
        if (!d) return { count: 0 };
        d.attempts++;
        return { count: 1 };
      },
      async count({ where }) { return deliveries.filter((x) => x.id === where.id).length; },
      async update({ where, data }) {
        const d = deliveries.find((x) => x.id === where.id);
        if (d) Object.assign(d, data);
        return {};
      },
    },
  };
  /** The inbox predicate of lib/notifications/read.ts (activeWhere): not archived, not expired. */
  const visible = (userId: string) => rows.filter((r) => r.userId === userId && r.archivedAt === null);
  return { rows, deliveries, client, resolveClient, retryClient, visible };
}

function prefs(rows: PreferenceOverride[]): PreferenceClient {
  return { notificationPreference: { async findMany() { return rows; }, async upsert() { throw new Error("unused"); } } } as unknown as PreferenceClient;
}
const NO_READ: PreferenceClient = {
  notificationPreference: { async findMany() { throw new Error("a locked type must not read preferences"); }, async upsert() { throw new Error("unused"); } },
} as unknown as PreferenceClient;

function ledgerSink() {
  const rows: CommsDeliveryRow[] = [];
  const writer: LedgerWriter = async (row) => { rows.push(row); };
  return { rows, writer };
}
function emailAdapter() {
  const sent: string[] = [];
  const adapter: ChannelAdapter = { channel: "EMAIL", name: "fake", async deliver(m) { sent.push(m.notificationId ?? ""); return { status: "sent", provider: "fake", id: "m" }; } };
  return { sent, adapter };
}

// ── 1. O-8: the Security Ops bell cannot be muted ─────────────────────────────

async function securityBellUnmutable(): Promise<void> {
  console.log("1. O-8 — the Security Ops bell cannot be muted by any preference combination");
  const bell: NotificationTypeDefinition = NOTIFICATION_REGISTRY.SECURITY_ANOMALY_DETECTED;
  const cells = PREFERENCE_CATEGORIES.flatMap((category) => PREFERENCE_CHANNELS.map((channel) => ({ category, channel })));
  // Every cell absent / off / on: 3^cells combinations, through the real resolver.
  let combos = 0;
  let muted = 0;
  let emailed = 0;
  const total = 3 ** cells.length;
  for (let i = 0; i < total; i++) {
    const overrides: PreferenceOverride[] = [];
    let x = i;
    for (const c of cells) {
      const v = x % 3; x = Math.floor(x / 3);
      if (v > 0) overrides.push({ ...c, enabled: v === 2 });
    }
    combos++;
    if (!resolveChannelEnabled(bell, "IN_APP", overrides)) muted++;
    if (resolveChannelEnabled(bell, "EMAIL", overrides)) emailed++;
  }
  check(`all ${combos} preference combinations (${cells.length} cells × absent/off/on): the bell is never muted`, muted === 0 && combos === total, { muted });
  check("…and none of them turns a notification email on for it (no double email)", emailed === 0, { emailed });

  // The chokepoint: the strongest mute a user can write; the type never even reads preferences.
  const s = store();
  const allOff = cells.map((c) => ({ ...c, enabled: false }));
  const r1 = await createNotification({ type: "SECURITY_ANOMALY_DETECTED", userId: "staff_1", data: { anomalyKey: "ip:h" + "a".repeat(32), title: "t", summary: "s" } },
    { client: s.client, prefClient: prefs(allOff), ledger: ledgerSink().writer });
  const r2 = await createNotification({ type: "SECURITY_ANOMALY_DETECTED", userId: "staff_2", data: { anomalyKey: "ip:h" + "b".repeat(32), title: "t", summary: "s" } },
    { client: s.client, prefClient: NO_READ, ledger: ledgerSink().writer });
  check("createNotification with every category × channel OFF still creates a VISIBLE bell", r1.status === "created" && s.visible("staff_1").length === 1);
  check("…and never reads preferences at all (a throwing preference client is untouched)", r2.status === "created" && s.visible("staff_2").length === 1);

  // Audit of every other security-class type: no preference can mute any of them.
  const securityClass = NOTIFICATION_TYPE_IDS.filter((id) => ["SECURITY_CRITICAL", "OPERATOR"].includes(COMMS_CATALOG[id].consentClass));
  const mutable = securityClass.filter((id) => {
    const d: NotificationTypeDefinition = NOTIFICATION_REGISTRY[id];
    return (["IN_APP", "EMAIL"] as const).some((ch) => resolveChannelEnabled(d, ch, allOff) !== d.defaultChannels.includes(ch)
      || resolveChannelEnabled(d, ch, allOff.map((o) => ({ ...o, enabled: true }))) !== d.defaultChannels.includes(ch));
  });
  check(`every security-class registry type (${securityClass.length}) is locked and unmoved by any preference`,
    mutable.length === 0 && securityClass.every((id) => NOTIFICATION_REGISTRY[id].locked), mutable);
  const securityStandalone = CATALOG_KEYS.filter((k) => !COMMS_CATALOG[k].notificationTypeId && ["SECURITY_CRITICAL", "OPERATOR"].includes(COMMS_CATALOG[k].consentClass));
  check(`every security-class direct / standalone definition (${securityStandalone.length}) is protected and not user-suppressible`,
    securityStandalone.every((k) => COMMS_CATALOG[k].protected && !COMMS_CATALOG[k].preference.userSuppressible));
}

// ── 2. O-8: hashed anomaly identifiers ────────────────────────────────────────

async function hashedIdentifiers(): Promise<void> {
  console.log("2. O-8 — no plaintext identifier / IP in the bell's dedupe key or metadata; dedupe still works");
  const SALTED = { SECURITY_IDENTIFIER_HASH_SALT: "unit-test-identifier-salt" };
  const identifier = "Victim.Person@Example.invalid";
  const ip = "203.0.113.77";
  const guesses = Array(6).fill("invalid_password");
  const [idAnomaly] = detectIdentifierAnomalies(guesses, identifier);
  const [, recAnomaly] = detectIdentifierAnomalies(Array(5).fill("recovery_code_invalid"), identifier);
  const ipAnomaly = detectIpAnomaly(Array(12).fill("invalid_password"), ip)!;
  const adminAnomaly = detectSystemAdminAnomaly(1)!;
  check("the detector's raw keys carry the plaintext (precondition: what must not leak)",
    idAnomaly.key.includes(identifier) && ipAnomaly.key.includes(ip) && recAnomaly?.key.includes(identifier));

  for (const a of [idAnomaly, recAnomaly!, ipAnomaly]) {
    const data = anomalyNotificationData(a, SALTED);
    const dedupe = fillDedupeTemplate(NOTIFICATION_REGISTRY.SECURITY_ANOMALY_DETECTED.dedupeKeyTemplate!, "staff_1", data);
    const blob = JSON.stringify(data) + dedupe;
    const raw = a.type === "failed_login_ip" ? ip : identifier;
    check(`${a.type}: metadata + dedupe key hold neither the raw value nor its lower-cased form`,
      !blob.includes(raw) && !blob.toLowerCase().includes(raw.toLowerCase()) && !blob.includes("203.0.113"), blob);
    check(`${a.type}: the anomaly key is the hashed form, keeping only the kind`, isHashedAnomalyKey(data.anomalyKey) && data.anomalyKey.startsWith(a.key.split(":")[0] + ":h"), data.anomalyKey);
    check(`${a.type}: same identifier ⇒ same key (dedupe identity)`, anomalyNotificationData(a, SALTED).anomalyKey === data.anomalyKey);
  }
  check("case / whitespace variants of one identifier hash alike", hashedAnomalyKey(`identifier:  ${identifier.toUpperCase()} `, SALTED) === hashedAnomalyKey(`identifier:${identifier}`, SALTED));
  check("different identifiers ⇒ different keys", hashedAnomalyKey("identifier:a@example.invalid", SALTED) !== hashedAnomalyKey("identifier:b@example.invalid", SALTED));
  check("the salt matters (a different salt ⇒ a different hash; never an unsalted digest)",
    hashSecurityIdentifier(ip, SALTED) !== hashSecurityIdentifier(ip, { SECURITY_IDENTIFIER_HASH_SALT: "other" }));
  check("the value-free admin-probe key is unchanged", anomalyNotificationData(adminAnomaly, SALTED).anomalyKey === "system_admin_disabled");
  check("hashing is idempotent", hashedAnomalyKey(hashedAnomalyKey(ipAnomaly.key, SALTED), SALTED) === hashedAnomalyKey(ipAnomaly.key, SALTED));
  check("an unknown key shape is hashed whole (fail safe)", !hashedAnomalyKey("weird:secret-value", SALTED).includes("secret-value"));
  const unsalted = anomalyNotificationData(ipAnomaly, {});
  check("salt AND NEXTAUTH_SECRET unset (no server secret at all) ⇒ still no plaintext, stable within the process (last-resort salt)",
    !JSON.stringify(unsalted).includes(ip) && anomalyNotificationData(ipAnomaly, {}).anomalyKey === unsalted.anomalyKey && unsalted.anomalyKey !== anomalyNotificationData(ipAnomaly, SALTED).anomalyKey);

  // Review item 2: the unset-salt fallback is STABLE across instances (derived, not random).
  const instanceA = { NEXTAUTH_SECRET: "deployment-session-secret" };
  const instanceB = { NEXTAUTH_SECRET: "deployment-session-secret" };
  const derived = createHmac("sha256", "deployment-session-secret").update(FALLBACK_SALT_LABEL).digest("hex");
  check("salt unset + NEXTAUTH_SECRET set ⇒ every instance derives the SAME salt (stable hash, dedupe holds across instances)",
    hashSecurityIdentifier(ip, instanceA) === hashSecurityIdentifier(ip, instanceB) &&
    hashSecurityIdentifier(ip, instanceA) === hashSecurityIdentifier(ip, { SECURITY_IDENTIFIER_HASH_SALT: derived }));
  check("…domain-separated: the salt is HMAC(NEXTAUTH_SECRET, label), never the secret itself",
    hashSecurityIdentifier(ip, instanceA) !== hashSecurityIdentifier(ip, { SECURITY_IDENTIFIER_HASH_SALT: "deployment-session-secret" }));
  check("…a different deployment secret ⇒ a different hash", hashSecurityIdentifier(ip, instanceA) !== hashSecurityIdentifier(ip, { NEXTAUTH_SECRET: "other-deployment" }));
  check("…a configured salt wins over the fallback", hashSecurityIdentifier(ip, { ...instanceA, ...SALTED }) === hashSecurityIdentifier(ip, SALTED));

  // Operators correlate: the audit trip row keeps the raw key and carries the bell's exact hash.
  const audit = anomalyAuditMetadata(idAnomaly, SALTED);
  check("audit trip row keeps the RAW key (unchanged forensic record + the detector's lock)", audit.key === idAnomaly.key);
  check("…and carries keyHash === the bell's anomalyKey (bell → trip-row correlation)", audit.keyHash === anomalyNotificationData(idAnomaly, SALTED).anomalyKey);

  // End to end through the chokepoint: two trips on the same identifier ⇒ one open bell; stored row has no plaintext.
  const s = store();
  const first = await createNotification({ type: "SECURITY_ANOMALY_DETECTED", userId: "staff_1", data: anomalyNotificationData(idAnomaly, SALTED) }, { client: s.client, ledger: ledgerSink().writer });
  const again = await createNotification({ type: "SECURITY_ANOMALY_DETECTED", userId: "staff_1", data: anomalyNotificationData(detectIdentifierAnomalies(Array(9).fill("invalid_password"), identifier)[0], SALTED) }, { client: s.client, ledger: ledgerSink().writer });
  const other = await createNotification({ type: "SECURITY_ANOMALY_DETECTED", userId: "staff_1", data: anomalyNotificationData(ipAnomaly, SALTED) }, { client: s.client, ledger: ledgerSink().writer });
  check("same identifier, second trip ⇒ suppressed (suppress-while-open on the hashed key)", first.status === "created" && again.status === "suppressed");
  check("a different anomaly ⇒ its own bell", other.status === "created" && s.visible("staff_1").length === 2);
  check("stored Notification rows (metadata + dedupeKey) contain no identifier or IP", s.rows.every((r) => !JSON.stringify(r).includes(identifier) && !JSON.stringify(r).includes(ip)), s.rows);

  // The producer really uses the builders (no raw key reaches createNotification).
  const src = readFileSync("lib/security/anomaly-alerts.ts", "utf8");
  check("anomaly-alerts.ts sends anomalyNotificationData(…) to the bell and anomalyAuditMetadata(…) to the trip row",
    /data:\s*anomalyNotificationData\(anomaly\)/.test(src) && /metadata:\s*anomalyAuditMetadata\(anomaly\)/.test(src) && !/anomalyKey:\s*anomaly\.key/.test(src));
}

// ── 3. O-7 owner ruling: connection-failure email independent of in-app ───────

const SYNC = { type: "SYNC_FAILED" as const, userId: "user_7", data: { plaidItemId: "item_1", institutionName: "Bank", connectionState: "ERROR" } };

async function connectionEmailIndependent(): Promise<void> {
  console.log("3. O-7 (owner ruling 2026-10-31) — FINANCIAL in-app off does not drop the connection-failure email");
  {
    const s = store(); const l = ledgerSink(); const e = emailAdapter();
    const ctx = { client: s.client, prefClient: prefs([{ category: "FINANCIAL", channel: "IN_APP", enabled: false }]), emailAdapter: e.adapter, ledger: l.writer };
    const r = await createNotification(SYNC, ctx);
    check("in-app off + email on (default) ⇒ the email is SENT", e.sent.length === 1 && e.sent[0] === r.id && s.deliveries.length === 1);
    check("…and nothing is visible in-app (the row is an archived email anchor)", s.visible("user_7").length === 0 && s.rows.length === 1 && s.rows[0].archivedAt !== null);
    check("…ledger: IN_APP SUPPRESSED PREFERENCE_OFF on the anchor (the email's row is sendEmail's)",
      l.rows.map((x) => `${x.channel}:${x.status}:${x.reason}`).join() === "IN_APP:SUPPRESSED:PREFERENCE_OFF" && l.rows[0].notificationId === r.id, l.rows);
    const again = await createNotification(SYNC, ctx);
    check("the next sync of the same broken item ⇒ suppressed: ONE email per outage (the anchor holds the key)",
      again.status === "suppressed" && e.sent.length === 1 && l.rows.slice(1).map((x) => `${x.channel}:${x.status}:${x.reason}`).join() === "IN_APP:SUPPRESSED:PREFERENCE_OFF,EMAIL:SUPPRESSED:DEDUPE_OPEN", l.rows);
    const retired = await retireOpenNotification("user_7", "SYNC_FAILED", { plaidItemId: "item_1" }, { client: s.resolveClient, now: NOW });
    check("recovery retires the archived anchor's key", retired === 1 && s.rows[0].dedupeKey === null);
    await createNotification(SYNC, ctx);
    check("…so a NEW outage emails again", e.sent.length === 2);
  }
  {
    const s = store(); const l = ledgerSink(); const e = emailAdapter();
    const r = await createNotification(SYNC, { client: s.client, prefClient: prefs([{ category: "FINANCIAL", channel: "IN_APP", enabled: false }, { category: "FINANCIAL", channel: "EMAIL", enabled: false }]), emailAdapter: e.adapter, ledger: l.writer });
    check("in-app off + email off ⇒ nothing sent, nothing stored", r.status === "skipped" && e.sent.length === 0 && s.rows.length === 0);
    check("…ledger: EMAIL SUPPRESSED with reason PREFERENCE_OFF (and IN_APP likewise)",
      l.rows.map((x) => `${x.channel}:${x.status}:${x.reason}`).join() === "IN_APP:SUPPRESSED:PREFERENCE_OFF,EMAIL:SUPPRESSED:PREFERENCE_OFF", l.rows);
  }
  {
    const s = store(); const l = ledgerSink(); const e = emailAdapter();
    const r = await createNotification(SYNC, { client: s.client, prefClient: prefs([{ category: "FINANCIAL", channel: "EMAIL", enabled: false }]), emailAdapter: e.adapter, ledger: l.writer });
    check("in-app on + email off ⇒ visible bell, no email, EMAIL SUPPRESSED PREFERENCE_OFF (unchanged)",
      r.status === "created" && s.visible("user_7").length === 1 && e.sent.length === 0 && l.rows.some((x) => x.channel === "EMAIL" && x.status === "SUPPRESSED" && x.reason === "PREFERENCE_OFF"), l.rows);
  }
  {
    const s = store(); const e = emailAdapter();
    const r = await createNotification(SYNC, { client: s.client, prefClient: prefs([]), emailAdapter: e.adapter, ledger: ledgerSink().writer });
    check("defaults ⇒ visible bell + email (unchanged)", r.status === "created" && s.visible("user_7").length === 1 && e.sent.length === 1);
  }
  {
    // Everything else unchanged: a non-connection type keeps the in-app/email coupling.
    const s = store(); const l = ledgerSink(); const e = emailAdapter();
    const r = await createNotification({ type: "IMPORT_COMPLETED", userId: "user_7", data: { batchId: "b1", rowCount: 3 } },
      { client: s.client, prefClient: prefs([{ category: "FINANCIAL", channel: "IN_APP", enabled: false }, { category: "FINANCIAL", channel: "EMAIL", enabled: true }]), emailAdapter: e.adapter, ledger: l.writer });
    check("another FINANCIAL type (IMPORT_COMPLETED) with in-app off ⇒ still skipped, its enabled email lost (S3 coupling kept)",
      r.status === "skipped" && e.sent.length === 0 && s.rows.length === 0 && l.rows.some((x) => x.channel === "EMAIL" && x.reason === "PREFERENCE_OFF"), l.rows);
  }
  {
    // Review item 4: turning in-app back ON mid-outage must not re-email the same outage.
    const s = store(); const e = emailAdapter();
    const off = { client: s.client, prefClient: prefs([{ category: "FINANCIAL", channel: "IN_APP", enabled: false }]), emailAdapter: e.adapter, ledger: ledgerSink().writer };
    const on = { client: s.client, prefClient: prefs([]), emailAdapter: e.adapter, ledger: ledgerSink().writer };
    await createNotification(SYNC, off);
    check("the anchor carries the chokepoint-owned marker", isEmailAnchorMetadata(s.rows[0].metadata));
    const reEnabled = await createNotification(SYNC, on);
    check("in-app re-enabled mid-outage ⇒ the anchor still holds the outage: suppressed, NO second email",
      reEnabled.status === "suppressed" && e.sent.length === 1 && s.rows.length === 1);
    await retireOpenNotification("user_7", "SYNC_FAILED", { plaidItemId: "item_1" }, { client: s.resolveClient, now: NOW });
    const next = await createNotification(SYNC, on);
    check("after recovery, the next outage notifies normally (visible bell + email)", next.status === "created" && s.visible("user_7").length === 1 && e.sent.length === 2);
  }
  {
    // A bell the user dismissed and THEN turned in-app off: its email already went out — no second one.
    const s = store(); const e = emailAdapter();
    await createNotification(SYNC, { client: s.client, prefClient: prefs([]), emailAdapter: e.adapter, ledger: ledgerSink().writer });
    s.rows[0].archivedAt = NOW; // dismissed
    const off = await createNotification(SYNC, { client: s.client, prefClient: prefs([{ category: "FINANCIAL", channel: "IN_APP", enabled: false }]), emailAdapter: e.adapter, ledger: ledgerSink().writer });
    check("dismissed bell + in-app turned off ⇒ the same outage is not re-emailed", off.status === "suppressed" && e.sent.length === 1 && s.rows.length === 1);
  }
  {
    // The marker is chokepoint-owned: a producer cannot forge an anchor.
    const s = store();
    await createNotification({ ...SYNC, data: { ...SYNC.data, [EMAIL_ANCHOR_MARKER]: true } as unknown as typeof SYNC.data },
      { client: s.client, prefClient: prefs([]), emailAdapter: emailAdapter().adapter, ledger: ledgerSink().writer });
    check("a producer-supplied anchor marker is stripped from a normal (visible) row", !isEmailAnchorMetadata(s.rows[0].metadata) && s.rows[0].archivedAt === null);
  }
  {
    // Review item 3: a failed anchor email is RETRIED by the retry job (normal policy), exactly once on success.
    const s = store();
    const failing: ChannelAdapter = { channel: "EMAIL", name: "fake", async deliver() { return { status: "error", provider: "fake", error: "transient" }; } };
    await createNotification(SYNC, { client: s.client, prefClient: prefs([{ category: "FINANCIAL", channel: "IN_APP", enabled: false }]), emailAdapter: failing, ledger: ledgerSink().writer });
    check("precondition: the anchor's first email attempt failed (error, attempt 1)", s.deliveries.length === 1 && s.deliveries[0].status === "error" && s.deliveries[0].attempts === 1);
    const retrySent: number[] = [];
    const ok: ChannelAdapter = { channel: "EMAIL", name: "fake", async deliver(m) { retrySent.push(m.attempt ?? 0); return { status: "sent", provider: "fake", id: "r1" }; } };
    const r1 = await retryNotifications(s.retryClient, ok, NOW, null);
    check("the retry job retries the archived anchor (not OBSOLETE) and sends exactly one email",
      r1.retried === 1 && r1.delivered === 1 && r1.skippedObsolete === 0 && retrySent.length === 1 && retrySent[0] === 2 && s.deliveries[0].status === "sent", r1);
    const r2 = await retryNotifications(s.retryClient, ok, NOW, null);
    check("…and a second pass sends nothing more", r2.examined === 0 && retrySent.length === 1);
  }
  {
    // Normal policy and DEAD semantics: a permanently failing anchor email stops at the cap, last attempt final.
    const s = store();
    const failing: ChannelAdapter = { channel: "EMAIL", name: "fake", async deliver() { return { status: "error", provider: "fake", error: "x" }; } };
    await createNotification(SYNC, { client: s.client, prefClient: prefs([{ category: "FINANCIAL", channel: "IN_APP", enabled: false }]), emailAdapter: failing, ledger: ledgerSink().writer });
    const finals: boolean[] = [];
    const stillFailing: ChannelAdapter = { channel: "EMAIL", name: "fake", async deliver(m) { finals.push(m.finalAttempt === true); return { status: "error", provider: "fake", error: "x" }; } };
    for (let i = 0; i < 5; i++) await retryNotifications(s.retryClient, stillFailing, NOW, null);
    check(`retries stop at the attempt cap (${MAX_DELIVERY_ATTEMPTS}); the last one is final (DEAD on the ledger)`,
      s.deliveries[0].attempts === MAX_DELIVERY_ATTEMPTS && finals.length === MAX_DELIVERY_ATTEMPTS - 1 && finals.at(-1) === true && finals.slice(0, -1).every((f) => !f), { attempts: s.deliveries[0].attempts, finals });
  }
  {
    // Contract v1.0.3 (owner storm policy): a RATE_LIMITED SYNC_FAILED email is not re-sent during the same outage.
    const s = store();
    const limited: ChannelAdapter = { channel: "EMAIL", name: "fake", async deliver() { return { status: "skipped", provider: "none" }; } };
    await createNotification(SYNC, { client: s.client, prefClient: prefs([]), emailAdapter: limited, ledger: ledgerSink().writer });
    const sent: string[] = [];
    const okAdapter: ChannelAdapter = { channel: "EMAIL", name: "fake", async deliver(m) { sent.push(m.notificationId ?? ""); return { status: "sent", provider: "fake" }; } };
    const retry = await retryNotifications(s.retryClient, okAdapter, NOW, null);
    const again = await createNotification(SYNC, { client: s.client, prefClient: prefs([]), emailAdapter: okAdapter, ledger: ledgerSink().writer });
    check("a storm-held (skipped) SYNC_FAILED email is never retried, and the next sync of the same outage is suppressed",
      s.deliveries[0].status === "skipped" && retry.examined === 0 && again.status === "suppressed" && sent.length === 0);
  }
  {
    // After retirement the anchor's failed email is obsolete again (the outage is over).
    const s = store();
    const failing: ChannelAdapter = { channel: "EMAIL", name: "fake", async deliver() { return { status: "error", provider: "fake", error: "x" }; } };
    await createNotification(SYNC, { client: s.client, prefClient: prefs([{ category: "FINANCIAL", channel: "IN_APP", enabled: false }]), emailAdapter: failing, ledger: ledgerSink().writer });
    await retireOpenNotification("user_7", "SYNC_FAILED", { plaidItemId: "item_1" }, { client: s.resolveClient, now: NOW });
    const sent: string[] = [];
    const r = await retryNotifications(s.retryClient, { channel: "EMAIL", name: "fake", async deliver(m) { sent.push(m.notificationId ?? ""); return { status: "sent", provider: "fake" }; } }, NOW, null);
    check("a retired anchor's failed email is closed OBSOLETE, not sent", r.skippedObsolete === 1 && sent.length === 0);
  }
  {
    // A visible bell the user dismissed (in-app ON) is still released and re-created, as before.
    const s = store(); const e = emailAdapter();
    const ctx = { client: s.client, prefClient: prefs([]), emailAdapter: e.adapter, ledger: ledgerSink().writer };
    await createNotification(SYNC, ctx);
    s.rows[0].archivedAt = NOW; // the user dismissed it
    const again = await createNotification(SYNC, ctx);
    check("in-app on: a dismissed (archived) holder is released and the condition notifies again (unchanged F3)", again.status === "created" && e.sent.length === 2);
  }
}

// ── 4. O-10: the storm limit ──────────────────────────────────────────────────

const PROD: EmailSendEnv = { VERCEL: "1", VERCEL_ENV: "production", NODE_ENV: "production", RESEND_API_KEY: "re_test", COMMS_RECIPIENT_HASH_SALT: "s" };
const capture: EmailProvider = { name: "capture", async send() { return { status: "captured", provider: "capture" }; } };

/** A sender over an in-memory ledger whose counter reads that same ledger (the production shape). */
function stormWorld(opts: { counter?: StormCounter; clock?: () => Date; defer?: (task: () => Promise<void>) => Promise<void>; failWrites?: boolean; pending?: PendingSends } = {}) {
  const ledger: Array<CommsDeliveryRow & { at: Date }> = [];
  const sent: EmailMessage[] = [];
  const logs: string[] = [];
  const clock = opts.clock ?? (() => NOW);
  const provider: EmailProvider = { name: "resend", async send(m) { sent.push(m); return { status: "sent", provider: "resend", id: `msg_${sent.length}` } as EmailResult; } };
  const counter: StormCounter = opts.counter ?? (async (q) => ledger.filter((r) =>
    r.channel === "EMAIL" && r.status === "ACCEPTED" && q.keys.includes(r.definitionKey) && r.at >= q.since &&
    (q.recipientUserId ? r.recipientUserId === q.recipientUserId : r.recipientHash === q.recipientHash)).length);
  const send = createEmailSender({
    env: PROD, provider, capture, now: clock, log: (l) => logs.push(l), storm: counter,
    ...(opts.defer ? { defer: opts.defer } : {}),
    ...(opts.pending ? { pending: opts.pending } : {}),
    ledger: async (row) => { if (opts.failWrites) throw new Error("ledger down"); ledger.push({ ...row, at: clock() }); },
  });
  return { send, ledger, sent, logs };
}
/** Minimal valid data for the generic notification template. */
const ND = { title: "Bank needs attention", category: "FINANCIAL" };
const notif = (userId: string | null) => ({ key: "SYNC_FAILED", recipientUserId: userId });

async function stormLimit(): Promise<void> {
  console.log("4. O-10 — at most 5 customer emails per recipient per rolling hour");
  {
    const w = stormWorld();
    const results: EmailResult[] = [];
    for (let i = 0; i < 6; i++) results.push(await w.send("notification", ADDRESS, ND, notif("user_1")));
    check("emails 1–5 are sent", results.slice(0, 5).every((r) => r.status === "sent") && w.sent.length === 5);
    check("the 6th is SUPPRESSED RATE_LIMITED and never reaches the provider",
      results[5].status === "skipped" && results[5].reason === "RATE_LIMITED" && w.sent.length === 5, results[5]);
    const last = w.ledger[w.ledger.length - 1];
    check("…recorded in the ledger as SUPPRESSED / RATE_LIMITED for that recipient", last.status === "SUPPRESSED" && last.reason === "RATE_LIMITED" && last.recipientUserId === "user_1" && last.definitionKey === "SYNC_FAILED", last);
    check("…with one redacted log line (no address)", w.logs.some((l) => /storm limit.*reason=RATE_LIMITED/.test(l)) && w.logs.every((l) => !l.includes(ADDRESS)));
    const other = await w.send("notification", "other@example.invalid", ND, notif("user_2"));
    check("the limit is per recipient: another user still receives mail", other.status === "sent");
    const awareness = await w.send("notification", ADDRESS, ND, { key: "MEMBER_ROLE_CHANGED", recipientUserId: "user_1" });
    check("it spans every customer email type: an AWARENESS email to the same user is held too", awareness.status === "skipped" && awareness.reason === "RATE_LIMITED");
    const sec = await w.send("security-alert", ADDRESS, { title: "t", message: "m" }, { key: "PASSWORD_CHANGED", recipientUserId: "user_1" });
    const reset = await w.send("password-reset", ADDRESS, { resetUrl: "https://app.example.invalid/reset?token=x" }, { key: "PASSWORD_RESET_LINK_SENT", recipientUserId: "user_1" });
    const verify = await w.send("email-verification", ADDRESS, { verifyUrl: "https://app.example.invalid/verify?token=x" }, { key: "EMAIL_VERIFICATION_SENT", recipientUserId: "user_1" });
    const change = await w.send("email-change", ADDRESS, { confirmUrl: "https://app.example.invalid/confirm?token=x" }, { key: "EMAIL_CHANGE_CONFIRMATION_SENT", recipientUserId: "user_1" });
    check("over the limit, SECURITY_CRITICAL still sends", sec.status === "sent", sec);
    check("over the limit, CEREMONY still sends (password reset, verification, email change)", [reset, verify, change].every((r) => r.status === "sent"), [reset, verify, change]);
    const op = await w.send("platform-alert", "ops@example.invalid", { evaluatedAtISO: NOW.toISOString(), alerts: [] }, { key: "PLATFORM_ALERT", recipientUserId: null });
    check("operator inbox mail is not customer mail: never limited", op.status !== "skipped", op);
  }
  {
    const w = stormWorld();
    for (let i = 0; i < 6; i++) await w.send("security-alert", ADDRESS, { title: "t", message: "m" }, { key: "PASSWORD_CHANGED", recipientUserId: "user_1" });
    const n = await w.send("notification", ADDRESS, ND, notif("user_1"));
    check("exempt mail is not counted: after 6 security emails a customer email still sends", w.sent.length === 7 && n.status === "sent");
  }
  {
    let t = NOW.getTime();
    const w = stormWorld({ clock: () => new Date(t) });
    for (let i = 0; i < 5; i++) await w.send("notification", ADDRESS, ND, notif("user_1"));
    t += 61 * 60_000;
    const later = await w.send("notification", ADDRESS, ND, notif("user_1"));
    check("the window is rolling: 61 minutes later the recipient can be mailed again", later.status === "sent");
  }
  {
    const w = stormWorld();
    const rs: EmailResult[] = [];
    for (let i = 0; i < 6; i++) rs.push(await w.send("notification", "Applicant@example.invalid", ND, { key: "SYNC_FAILED", recipientUserId: null }));
    const otherAddr = await w.send("notification", "someone.else@example.invalid", ND, { key: "SYNC_FAILED", recipientUserId: null });
    check("no userId: counted by the ledger's salted recipient hash — the 6th to that address is held",
      rs.slice(0, 5).every((r) => r.status === "sent") && rs[5].reason === "RATE_LIMITED" && w.ledger[0].recipientHash !== null && otherAddr.status === "sent", rs[5]);
  }
  console.log("4a. in-request bursts — the ledger write is deferred, the in-process reservations still hold the limit");
  {
    // One invocation: every ledger write is deferred until after the "response" (like next/server after()).
    const queued: Array<() => Promise<void>> = [];
    const pending = new PendingSends();
    const w = stormWorld({ defer: async (task) => { queued.push(task); }, pending });
    const rs: EmailResult[] = [];
    for (let i = 0; i < 10; i++) rs.push(await w.send("notification", ADDRESS, ND, notif("user_1")));
    check("10 sends in ONE invocation (ledger not yet written) ⇒ 5 sent, 5 RATE_LIMITED",
      rs.filter((r) => r.status === "sent").length === 5 && rs.filter((r) => r.reason === "RATE_LIMITED").length === 5 && w.sent.length === 5 && w.ledger.length === 0,
      rs.map((r) => r.status));
    for (const task of queued.splice(0)) await task();
    check("after the deferred writes land, the reservations are released (the DB count now holds them)", pending.size === 0 && w.ledger.filter((r) => r.status === "ACCEPTED").length === 5);
    const after = await w.send("notification", ADDRESS, ND, notif("user_1"));
    check("…and the limit still holds from the ledger, with no double count", after.reason === "RATE_LIMITED" && w.sent.length === 5);
  }
  {
    const queued: Array<() => Promise<void>> = [];
    const w = stormWorld({ defer: async (task) => { queued.push(task); } });
    const rs = await Promise.all(Array.from({ length: 10 }, () => w.send("notification", ADDRESS, ND, notif("user_1"))));
    check("10 CONCURRENT sends in one invocation ⇒ exactly 5 sent (check-and-reserve is atomic)", rs.filter((r) => r.status === "sent").length === 5 && w.sent.length === 5, rs.map((r) => r.status));
  }
  {
    // A NON-ACCEPTED send (provider error) releases its reservation at once — even with the ledger write deferred.
    const queued: Array<() => Promise<void>> = [];
    const pending = new PendingSends();
    let fail = true;
    const sent: EmailMessage[] = [];
    const send = createEmailSender({
      env: PROD, capture, now: () => NOW, log: () => undefined, storm: async () => 0, pending,
      defer: async (task) => { queued.push(task); }, ledger: async () => undefined,
      provider: { name: "resend", async send(m) { sent.push(m); return fail ? { status: "error", provider: "resend", error: "boom" } : { status: "sent", provider: "resend", id: "x" }; } },
    });
    for (let i = 0; i < 5; i++) await send("notification", ADDRESS, ND, notif("user_1"));
    check("5 provider errors leave no reservation behind", pending.count("u:user_1", NOW.getTime()) === 0);
    fail = false;
    const sixth = await send("notification", ADDRESS, ND, notif("user_1"));
    check("…so a 6th send to the same recipient is NOT rate-limited", sixth.status === "sent" && sent.length === 6, sixth);
  }
  {
    // A send whose ledger write fails keeps its reservation until it ages out (an unrecorded send still counts).
    let t = NOW.getTime();
    const w = stormWorld({ failWrites: true, clock: () => new Date(t) });
    for (let i = 0; i < 5; i++) await w.send("notification", ADDRESS, ND, notif("user_1"));
    const sixth = await w.send("notification", ADDRESS, ND, notif("user_1"));
    check("ledger writes failing ⇒ the reservations stand: the 6th is still RATE_LIMITED", sixth.reason === "RATE_LIMITED" && w.sent.length === 5);
    t += 61 * 60_000;
    const later = await w.send("notification", ADDRESS, ND, notif("user_1"));
    check("…and they age out with the window", later.status === "sent");
  }
  {
    const queued: Array<() => Promise<void>> = [];
    const w = stormWorld({ defer: async (task) => { queued.push(task); } });
    for (let i = 0; i < 5; i++) await w.send("notification", ADDRESS, ND, notif("user_1"));
    const sec = await w.send("security-alert", ADDRESS, { title: "t", message: "m" }, { key: "PASSWORD_CHANGED", recipientUserId: "user_1" });
    check("exempt mail is never held by in-process reservations", sec.status === "sent");
  }
  {
    // Bounded memory: pruned by window, capped per recipient and in recipients.
    const p = new PendingSends(60 * 60_000, 3);
    const t0 = NOW.getTime();
    for (let i = 0; i < 10; i++) p.reserve(`u:${i}`, t0);
    check("the reservation map never holds more than its recipient cap (oldest evicted)", p.size === 3 && p.count("u:9", t0) === 1 && p.count("u:0", t0) === 0);
    for (let i = 0; i < 20; i++) p.reserve("u:9", t0);
    check("a recipient never holds more reservations than the limit", p.count("u:9", t0) === EMAIL_STORM_LIMIT.maxPerRecipient);
    check("entries older than the window are pruned on access", p.count("u:9", t0 + 61 * 60_000) === 0 && p.size === 2);
  }

  console.log("4b. an unreadable count — limited mail fails CLOSED, exempt mail fails OPEN");
  {
    const w = stormWorld({ counter: async () => { throw new Error("db down"); } });
    const limited = await w.send("notification", ADDRESS, ND, notif("user_1"));
    const sec = await w.send("security-alert", ADDRESS, { title: "t", message: "m" }, { key: "PASSWORD_CHANGED", recipientUserId: "user_1" });
    const ceremony = await w.send("password-reset", ADDRESS, { resetUrl: "https://app.example.invalid/reset?token=x" }, { key: "PASSWORD_RESET_LINK_SENT", recipientUserId: "user_1" });
    check("counter throws ⇒ the limited send is SUPPRESSED RATE_LIMIT_UNVERIFIED, recorded, not sent",
      limited.status === "skipped" && limited.reason === "RATE_LIMIT_UNVERIFIED" && w.ledger[0].status === "SUPPRESSED" && w.ledger[0].reason === "RATE_LIMIT_UNVERIFIED", w.ledger[0]);
    check("…security and ceremony still send", sec.status === "sent" && ceremony.status === "sent" && w.sent.length === 2);
  }
  {
    const hang: StormCounter = () => new Promise<number>(() => undefined);
    const d = await decideStorm({ key: "SYNC_FAILED", recipientUserId: "u", recipientHash: null, counter: hang, now: NOW, timeoutMs: 20 });
    const ex = await decideStorm({ key: "PASSWORD_RESET_LINK_SENT", recipientUserId: "u", recipientHash: null, counter: hang, now: NOW, timeoutMs: 20 });
    check("a counter that never answers ⇒ RATE_LIMIT_UNVERIFIED after the timeout", !d.send && d.reason === "RATE_LIMIT_UNVERIFIED");
    check("…while an exempt key never even asks the counter", ex.send && ex.exempt);
    const bad = await decideStorm({ key: "SYNC_FAILED", recipientUserId: "u", recipientHash: null, counter: async () => Number.NaN, now: NOW });
    check("a nonsense count ⇒ RATE_LIMIT_UNVERIFIED", !bad.send && bad.reason === "RATE_LIMIT_UNVERIFIED");
  }
  {
    // No user and no salt ⇒ no identity to count by.
    const sent: EmailMessage[] = [];
    const ledger: CommsDeliveryRow[] = [];
    const send = createEmailSender({
      env: { ...PROD, COMMS_RECIPIENT_HASH_SALT: undefined }, capture, now: () => NOW, log: () => undefined,
      provider: { name: "resend", async send(m) { sent.push(m); return { status: "sent", provider: "resend", id: "x" }; } },
      storm: async () => 0, ledger: async (row) => { ledger.push(row); },
    });
    const r = await send("notification", "x@example.invalid", ND, { key: "SYNC_FAILED", recipientUserId: null });
    check("no userId and no recipient salt ⇒ the limited send fails closed (RATE_LIMIT_UNVERIFIED)", r.status === "skipped" && r.reason === "RATE_LIMIT_UNVERIFIED" && sent.length === 0);
  }
  {
    // The storm limit sits AFTER the recipient guard: a guarded (captured) Preview send is not counted or limited.
    const asked: number[] = [];
    const send = createEmailSender({
      env: { ...PROD, VERCEL_ENV: "preview" }, capture, now: () => NOW, log: () => undefined,
      provider: { name: "resend", async send() { return { status: "sent", provider: "resend", id: "x" }; } },
      storm: async () => { asked.push(1); return 99; },
    });
    const r = await send("notification", ADDRESS, ND, notif("user_1"));
    check("the guard runs first: a non-allowlisted Preview send is CAPTURED, the counter is never asked", r.status === "captured" && asked.length === 0);
  }
  const src = readFileSync("lib/email/send.ts", "utf8");
  const guardAt = src.indexOf("decideRecipient(to, env)");
  const stormAt = src.indexOf("decideStorm(");
  const providerAt = src.indexOf("deps.provider.send(");
  check("send.ts: guard → storm limit → provider, in that order (single chokepoint)", guardAt > 0 && stormAt > guardAt && providerAt > stormAt);
  check("production sendEmail is wired to the ledger counter", /storm: countRecentAcceptedEmails,/.test(src));
}

// ── 5. the catalog reflects every change ──────────────────────────────────────

function catalogReflects(): void {
  console.log("5. the catalog reflects every change");
  const bell = COMMS_CATALOG.SECURITY_ANOMALY_DETECTED;
  check("SECURITY_ANOMALY_DETECTED: protected: true, userSuppressible: false, no preference row", bell.protected && !bell.preference.userSuppressible && bell.preference.category === null);
  check("…its only leg is IN_APP (the PLATFORM email opt-in leg is gone with the lock)", bell.channels.map((c) => c.channel).join() === "IN_APP", bell.channels);
  check("…its anomalyKey payload field is not PII (a salted hash)", bell.payload.find((p) => p.name === "anomalyKey")?.pii === false);
  check("the known-gap pins are empty (R-2 and R-3 closed)", Object.keys(KNOWN_SUPPRESSIBILITY_GAPS).length === 0 && Object.keys(KNOWN_PII_DEDUPE_KEYS).length === 0);
  check("SYNC_FAILED: still user-suppressible on both channels; its description states the email independence",
    COMMS_CATALOG.SYNC_FAILED.preference.userSuppressible && COMMS_CATALOG.SYNC_FAILED.preference.suppressibleChannels.join() === "IN_APP,EMAIL" && /does not stop the email/.test(COMMS_CATALOG.SYNC_FAILED.description));
  check("storm limit constant: 5 per 60 minutes", EMAIL_STORM_LIMIT.maxPerRecipient === 5 && EMAIL_STORM_LIMIT.windowMinutes === 60);
  check("global platform cap: documented TODO, OFF (null) by default", GLOBAL_EMAIL_CAP_PER_HOUR === null);
  check("limited classes are exactly SERVICE / AWARENESS / MARKETING", EMAIL_STORM_LIMITED_CLASSES.join() === "SERVICE,AWARENESS,MARKETING");
  const exemptLeak = CATALOG_KEYS.filter((k) => ["SECURITY_CRITICAL", "CEREMONY", "OPERATOR"].includes(COMMS_CATALOG[k].consentClass) && isStormLimitedKey(k));
  check("no SECURITY_CRITICAL / CEREMONY / OPERATOR key is storm-limited", exemptLeak.length === 0, exemptLeak);
  check("every ENABLED customer email of a limited class is storm-limited",
    CATALOG_KEYS.filter((k) => COMMS_CATALOG[k].status === "ENABLED" && COMMS_CATALOG[k].channels.some((c) => c.channel === "EMAIL") && EMAIL_STORM_LIMITED_CLASSES.includes(COMMS_CATALOG[k].consentClass)).every(isStormLimitedKey));
  check("an uncatalogued key (tooling) is not customer mail", !isStormLimitedKey("UNCATALOGUED") && !isStormLimitedKey("smoke"));
  check("the ledger vocabulary carries RATE_LIMITED and RATE_LIMIT_UNVERIFIED", SUPPRESSION_REASONS.includes("RATE_LIMITED") && SUPPRESSION_REASONS.includes("RATE_LIMIT_UNVERIFIED"));
}

async function main(): Promise<void> {
  await securityBellUnmutable();
  await hashedIdentifiers();
  await connectionEmailIndependent();
  await stormLimit();
  catalogReflects();
  console.log(failures === 0 ? "\nAll Comms Center A-2b checks passed." : `\n${failures} failure(s).`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
