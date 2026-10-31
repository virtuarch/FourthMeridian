/**
 * lib/notifications/catalog/catalog.test.ts  (Comms Center Phase A-1)
 *
 * The unified catalog is COMPLETE, LAWFUL and HONEST about today's behaviour.
 *
 *   1. completeness — every registry type has exactly one entry; every grepped
 *      email send site (sendEmail / purge's injected `email(` / sendSecurityAlert /
 *      the channel adapter) maps onto EXACTLY ONE catalog leg; every catalog
 *      source is a real producer; every security-alert builder and template is
 *      claimed; previews resolve; the contract's 58 keys are all present.
 *   2. invariants (contract §2) — consent ⇒ protected / not suppressible; the
 *      registry pointer agrees on category and severity; no LINK or PII field in
 *      a dedupe key (known gap pinned).
 *   3. suppressibility, BEHAVIOURALLY — the real resolveChannelEnabled and the
 *      real setNotificationPreference decide what a user can mute; the catalog's
 *      `userSuppressible` must equal that, and the only protected entry a user
 *      can mute today is the pinned finding (SECURITY_ANOMALY_DETECTED, AUDIT R-2).
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/notifications/catalog/catalog.test.ts
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CATALOG_KEYS,
  COMMS_CATALOG,
  KNOWN_PII_DEDUPE_KEYS,
  KNOWN_SUPPRESSIBILITY_GAPS,
  MATRIX_CATEGORIES,
  NON_CATALOG_TEMPLATES,
  PRIORITY_SEVERITY,
  REGISTRY_CATALOG,
} from "@/lib/notifications/catalog/definitions";
import { TRIGGER_CATALOG } from "@/lib/notifications/catalog/triggers";
import { NOTIFICATION_REGISTRY, NOTIFICATION_TYPE_IDS } from "@/lib/notifications/registry";
import {
  PREFERENCE_CATEGORIES,
  resolveChannelEnabled,
  setNotificationPreference,
  type PreferenceClient,
} from "@/lib/notifications/preferences";
import { EMAIL_TEMPLATES } from "@/lib/email/templates";
import { previewCases } from "@/lib/email/preview";
import * as alerts from "@/lib/email/security-alerts";
import { TRIGGER_KEYS, type ChannelLeg, type CommsDefinition } from "@/lib/notifications/catalog/types";
import type { NotificationTypeDefinition } from "@/lib/notifications/types";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
  }
}

const defs: CommsDefinition[] = CATALOG_KEYS.map((k) => COMMS_CATALOG[k]);
const read = (f: string) => readFileSync(f, "utf8");
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).replace(/(^|[^:])\/\/.*$/gm, "$1");
}
function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

// ── Grep every email send site (the lib/email/catalog.test.ts patterns) ───────

type Site = { file: string; template: string; builder: string | null; via: string };
const NOT_SENDERS = new Set(["lib/email/send.ts", "lib/email/preview.ts", "lib/email/send-security-alert.ts"]);
/** The preview tool sends only preview cases to the allowlisted local address — not a production message. */
const TOOLING = new Set(["scripts/email-preview.ts"]);
/** The registry's generic EMAIL path: one site serves every registry type's EMAIL leg. */
const REGISTRY_EMAIL_PATH = new Set(["lib/notifications/channels/email.ts", "lib/notifications/create.ts", "jobs/retry-notifications.ts"]);

const LITERAL_RE = /(\bsendEmail|(?<![.\w])email)\(\s*"([^"]*)"\s*,/g;
const GUARDED_RE = /(?<![.\w])sendSecurityAlert\(/g;
const ADAPTER_RE = /\b(?:adapter|args\.adapter)\.deliver\(/g;
const VARIABLE_RE = /\bsendEmail\(\s*(?!["\s])/g;
const BUILDER_RE = /\b(\w+Alert)\(/;

const sites: Site[] = [];
const variableSites = new Set<string>();
for (const root of ["app", "lib", "jobs", "scripts"]) {
  for (const file of walk(root)) {
    if (NOT_SENDERS.has(file)) continue;
    const code = stripComments(read(file));
    const builderAfter = (at: number) => BUILDER_RE.exec(code.slice(at, at + 400))?.[1] ?? null;
    for (const m of code.matchAll(LITERAL_RE)) {
      sites.push({ file, template: m[2], builder: m[2] === "security-alert" ? builderAfter(m.index! + m[0].length) : null, via: m[1] });
    }
    for (const m of code.matchAll(GUARDED_RE)) sites.push({ file, template: "security-alert", builder: builderAfter(m.index! + m[0].length), via: "sendSecurityAlert" });
    for (const _ of code.matchAll(ADAPTER_RE)) sites.push({ file, template: "notification", builder: null, via: "adapter.deliver" });
    for (const _ of code.matchAll(VARIABLE_RE)) variableSites.add(file);
  }
}

const emailLegs = defs.flatMap((d) => d.channels.filter((c) => c.email).map((leg) => ({ def: d, leg: leg as ChannelLeg & { email: NonNullable<ChannelLeg["email"]> } })));

function main(): void {
  console.log("1. completeness");
  {
    check("the catalog has 58 entries at v1 (contract §4.2 C7c)", defs.length === 58, defs.length);
    check("catalog size ≤ 100, so limit=100 returns it in one page", defs.length <= 100);
    check("every key is unique and equals its definition key", new Set(CATALOG_KEYS).size === defs.length && defs.every((d, i) => d.key === CATALOG_KEYS[i]));
    check("keys follow the F2 grammar (SCREAMING_SNAKE, ≥ 2 segments)", defs.every((d) => /^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$/.test(d.key)));

    for (const id of NOTIFICATION_TYPE_IDS) {
      const owners = defs.filter((d) => d.notificationTypeId === id);
      check(`registry ${id}: exactly one catalog entry, keyed by its id`, owners.length === 1 && owners[0].key === id, owners.map((o) => o.key));
    }
    check("REGISTRY_CATALOG keys == registry ids (no orphan metadata)",
      Object.keys(REGISTRY_CATALOG).sort().join() === [...NOTIFICATION_TYPE_IDS].sort().join());

    check("the grep found the known send sites (sanity: ≥ 20)", sites.length >= 20, sites.length);
    check("the only variable-name sender is the preview tool", [...variableSites].every((f) => TOOLING.has(f)), [...variableSites]);
    for (const s of sites) {
      if (TOOLING.has(s.file)) continue;
      const label = `${s.file} → ${s.template}${s.builder ? `·${s.builder}` : ""}`;
      if (s.template === "notification") {
        check(`${label}: is the registry EMAIL path`, REGISTRY_EMAIL_PATH.has(s.file));
        continue;
      }
      const owners = emailLegs.filter(({ def, leg }) =>
        leg.path === "DIRECT" && leg.email.template === s.template && (s.builder === null || leg.email.builder === s.builder) && def.trigger.sources.includes(s.file));
      check(`${label}: exactly one catalog leg`, owners.length === 1, owners.map((o) => o.def.key));
    }
    check("the registry EMAIL path is present (adapter + chokepoint caller)",
      [...REGISTRY_EMAIL_PATH].every((f) => sites.some((s) => s.file === f && s.template === "notification")));
    for (const { def, leg } of emailLegs.filter((e) => e.leg.path === "DIRECT")) {
      for (const src of def.trigger.sources) {
        if (src.startsWith("lib/events/handlers/")) continue; // the in-app producer of a two-leg type
        const claims = sites.some((s) => s.file === src && s.template === leg.email.template && (leg.email.builder === undefined || s.builder === leg.email.builder));
        const producesInApp = def.notificationTypeId !== null && new RegExp(`type:\\s*"${def.notificationTypeId}"`).test(read(src));
        check(`${def.key}: source ${src} really sends ${leg.email.template}${leg.email.builder ? `·${leg.email.builder}` : ""} or produces the in-app leg`, claims || producesInApp);
      }
    }
    for (const id of NOTIFICATION_TYPE_IDS) {
      const excluded = ((NOTIFICATION_REGISTRY[id] as NotificationTypeDefinition).excludedChannels ?? []) as readonly string[];
      for (const ch of excluded) {
        check(`${id}: excluded ${ch} has no registry leg (PR #166)`, !COMMS_CATALOG[id].channels.some((c) => c.path === "REGISTRY" && c.channel === ch));
      }
    }
    check("SPACE_INVITE_RECEIVED: exactly one email leg, the direct space-invite",
      COMMS_CATALOG.SPACE_INVITE_RECEIVED.channels.filter((c) => c.channel === "EMAIL").map((c) => `${c.path}:${c.email?.template}`).join() === "DIRECT:space-invite");
    check("every registry EMAIL leg uses the generic notification template",
      emailLegs.filter((e) => e.leg.path === "REGISTRY").every((e) => e.leg.email.template === "notification"));

    for (const fn of Object.keys(alerts).filter((k) => k.endsWith("Alert"))) {
      const owners = emailLegs.filter((e) => e.leg.email.builder === fn);
      check(`security-alert builder ${fn}: exactly one catalog leg`, owners.length === 1, owners.map((o) => o.def.key));
    }
    for (const name of Object.keys(EMAIL_TEMPLATES)) {
      const claimed = emailLegs.some((e) => e.leg.email.template === name);
      check(`template "${name}": claimed by a catalog leg, or listed as non-catalog`, claimed !== (name in NON_CATALOG_TEMPLATES));
    }

    for (const id of NOTIFICATION_TYPE_IDS) {
      const def = COMMS_CATALOG[id];
      if (NOTIFICATION_REGISTRY[id].status !== "WIRED") {
        check(`${id} (VOCABULARY): no producer source claimed`, def.trigger.sources.length === 0 || def.status !== "ENABLED");
        continue;
      }
      const produced = def.trigger.sources.some((f) => new RegExp(`type:\\s*"${id}"`).test(stripComments(read(f))));
      check(`${id} (WIRED): a listed source really produces it`, produced, def.trigger.sources);
    }
    for (const d of defs) {
      for (const f of d.trigger.sources) {
        let exists = true;
        try { read(f); } catch { exists = false; }
        check(`${d.key}: source ${f} exists`, exists);
      }
    }

    const slugs = new Set(previewCases().map((c) => c.slug));
    const claimedSlugs = new Set(defs.flatMap((d) => d.channels.flatMap((c) => c.previewSlugs ?? [])));
    check("every catalog preview slug is a real lib/email/preview.ts case", [...claimedSlugs].every((s) => slugs.has(s)), [...claimedSlugs].filter((s) => !slugs.has(s)));
    check("every preview case (except smoke) is claimed by a catalog leg", [...slugs].filter((s) => s !== "smoke").every((s) => claimedSlugs.has(s)), [...slugs].filter((s) => s !== "smoke" && !claimedSlugs.has(s)));

    for (const id of NOTIFICATION_TYPE_IDS) {
      const names = COMMS_CATALOG[id].payload.map((p) => p.name).sort().join();
      check(`${id}: typed payload == registry pointerContract`, names === [...NOTIFICATION_REGISTRY[id].pointerContract].sort().join(), names);
    }
    check("MATRIX_CATEGORIES mirrors preferences.PREFERENCE_CATEGORIES", [...MATRIX_CATEGORIES].sort().join() === [...PREFERENCE_CATEGORIES].sort().join());

    const CONTRACT_KEYS = [
      // §8.1 direct + banners
      "PASSWORD_RESET_LINK_SENT", "EMAIL_VERIFICATION_SENT", "EMAIL_CHANGE_CONFIRMATION_SENT", "TWO_FACTOR_RESET_BY_ADMIN",
      "ACCOUNT_DELETED", "SIGN_IN_ANOMALY_OWNER", "BETA_INVITATION_ISSUED", "BETA_REQUEST_RECEIVED", "PLATFORM_ALERT",
      "SECURITY_ANOMALY_INBOX", "MAINTENANCE_NOTICE", "TWO_FACTOR_REMINDER", "CONNECT_INVITATION",
      // §8.2 BUILD, §8.3, §8.4, §8.5
      "PLAID_ITEM_REAUTH_REQUIRED", "PLAID_ITEM_REVOKED", "WALLET_SYNC_FAILED", "ACCOUNT_WELCOME", "PLATFORM_ACCESS_GRANTED",
      "DIGEST_SENT", "BETA_REQUEST_DENIED",
      "BETA_INVITATION_EXPIRING", "BETA_PROGRAM_STATUS_CHANGED", "WALLET_IMPORT_COMPLETED", "MAINTENANCE_SCHEDULED", "PROVIDER_INCIDENT_NOTICE",
    ];
    check("every key the contract (§8) names is catalogued", CONTRACT_KEYS.every((k) => k in COMMS_CATALOG), CONTRACT_KEYS.filter((k) => !(k in COMMS_CATALOG)));
    const byStatus = (s: string) => defs.filter((d) => d.status === s).map((d) => d.key).sort().join();
    check("BUILD = the five §8.2 keys", byStatus("BUILD") === ["ACCOUNT_WELCOME", "PLATFORM_ACCESS_GRANTED", "PLAID_ITEM_REAUTH_REQUIRED", "PLAID_ITEM_REVOKED", "WALLET_SYNC_FAILED"].sort().join());
    check("BUILD_OFF = DIGEST_SENT; NONE_BY_DESIGN = BETA_REQUEST_DENIED", byStatus("BUILD_OFF") === "DIGEST_SENT" && byStatus("NONE_BY_DESIGN") === "BETA_REQUEST_DENIED");
    check("ENABLED = 21 WIRED registry types + 13 direct/banner keys", defs.filter((d) => d.status === "ENABLED").length === 34);
    check("NONE_BY_DESIGN has no channel; non-ENABLED definitions claim no DIRECT leg",
      COMMS_CATALOG.BETA_REQUEST_DENIED.channels.length === 0 && defs.filter((d) => d.status !== "ENABLED").every((d) => d.channels.every((c) => c.path !== "DIRECT")));
    check("every trigger key in a definition is in the trigger catalog", defs.every((d) => d.trigger.triggerKey === null || d.trigger.triggerKey in TRIGGER_CATALOG));
    check("the trigger catalog is exactly TRIGGER_KEYS", Object.keys(TRIGGER_CATALOG).sort().join() === [...TRIGGER_KEYS].sort().join());
    check("no trigger is a comms-originated event (§5.1: no self-triggering)", TRIGGER_KEYS.every((k) => !/delivery|notification|email\.|comms/.test(k)));
  }

  console.log("2. invariants (contract §2)");
  {
    for (const d of defs) {
      if (d.consentClass === "SECURITY_CRITICAL" || d.consentClass === "CEREMONY") {
        check(`${d.key}: ${d.consentClass} ⇒ protected, not user-suppressible, never pausable`,
          d.protected && !d.preference.userSuppressible && d.preference.category === null && !d.supportedActions.includes("PAUSE_AUTOMATION"));
      }
      if (d.consentClass === "MARKETING") check(`${d.key}: MARKETING ⇒ preference row, never protected`, d.preference.category !== null && !d.protected);
      if (d.editable) check(`${d.key}: editable ⇒ not protected`, !d.protected);
      if (d.protected) check(`${d.key}: protected ⇒ no automation action`, !d.supportedActions.some((a) => a === "AUTOMATE" || a === "PAUSE_AUTOMATION" || a === "ACTIVATE_AUTOMATION"));
      check(`${d.key}: suppressible channels are a subset of its channels`, d.preference.suppressibleChannels.every((c) => d.channels.some((l) => l.channel === c)));
      if (d.notificationTypeId) {
        const r = NOTIFICATION_REGISTRY[d.notificationTypeId];
        check(`${d.key}: category and severity agree with the registry`, d.category === r.category && d.severity === PRIORITY_SEVERITY[r.priority]);
      }
      if (d.dedupe.keyTemplate) {
        const placeholders = [...d.dedupe.keyTemplate.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
        const unsafe = placeholders.filter((n) => d.payload.some((p) => p.name === n && (p.kind === "LINK" || p.pii)));
        check(`${d.key}: dedupe key has no LINK or PII field${d.key in KNOWN_PII_DEDUPE_KEYS ? " (KNOWN gap pinned)" : ""}`,
          (unsafe.length === 0) === !(d.key in KNOWN_PII_DEDUPE_KEYS), unsafe);
      }
      for (const leg of d.channels) {
        if (leg.email?.builder) check(`${d.key}: a builder leg uses the security-alert template`, leg.email.template === "security-alert");
      }
    }
    // v1.0.1 — only ENABLED definitions advertise what they do today.
    for (const d of defs.filter((x) => x.status !== "ENABLED")) {
      check(`${d.key} (${d.status}): no leg is default-on`, d.channels.every((c) => c.defaultOn === false));
      check(`${d.key} (${d.status}): only read-only actions (PREVIEW / VIEW_DELIVERY / LINK_OUT), not editable`,
        !d.editable && d.supportedActions.every((a) => a === "PREVIEW" || a === "VIEW_DELIVERY" || a === "LINK_OUT"), d.supportedActions);
    }
    check("editable ⇔ AUTOMATE advertised", defs.every((d) => d.editable === d.supportedActions.includes("AUTOMATE")));
    check("ENABLED registry legs keep the registry defaults (no behaviour drift)",
      NOTIFICATION_TYPE_IDS.filter((id) => COMMS_CATALOG[id].status === "ENABLED").every((id) =>
        COMMS_CATALOG[id].channels.filter((c) => c.path === "REGISTRY").every((c) =>
          c.defaultOn === (NOTIFICATION_REGISTRY[id].defaultChannels as readonly string[]).includes(c.channel))));
    check("no MARKETING definition exists in v1 (O-12)", defs.every((d) => d.consentClass !== "MARKETING"));
    const protectedEntries = defs.filter((d) => d.protected).map((d) => d.key);
    check("every ACCOUNT_SECURITY / ceremony / operator entry is protected",
      defs.filter((d) => d.category === "ACCOUNT_SECURITY" || d.category === "CEREMONY" || d.category === "OPERATOR").every((d) => d.protected),
      defs.filter((d) => (d.category === "ACCOUNT_SECURITY" || d.category === "CEREMONY" || d.category === "OPERATOR") && !d.protected).map((d) => d.key));
    check("the security staff bell and both inbox emails are protected",
      ["SECURITY_ANOMALY_DETECTED", "SECURITY_ANOMALY_INBOX", "SIGN_IN_ANOMALY_OWNER", "PLATFORM_ALERT"].every((k) => protectedEntries.includes(k)));
  }

  console.log("3. suppressibility, against the real preference code");
  {
    // The strongest mute a user can write: every category × channel off.
    const allOff = MATRIX_CATEGORIES.flatMap((category) => ["IN_APP", "EMAIL"].map((channel) => ({ category, channel, enabled: false })));
    const canMuteInApp: string[] = [];
    for (const id of NOTIFICATION_TYPE_IDS) {
      const r: NotificationTypeDefinition = NOTIFICATION_REGISTRY[id];
      const settable = PREFERENCE_CATEGORIES.includes(r.category);
      const mutable = settable && (["IN_APP", "EMAIL"] as const).some((ch) => r.defaultChannels.includes(ch) && !resolveChannelEnabled(r, ch, allOff));
      const optIn = settable && (["IN_APP", "EMAIL"] as const).some((ch) => !r.defaultChannels.includes(ch) && resolveChannelEnabled(r, ch, allOff.map((o) => ({ ...o, enabled: true }))));
      const def = COMMS_CATALOG[id];
      check(`${id}: catalog userSuppressible (${def.preference.userSuppressible}) == what the preference code does`, def.preference.userSuppressible === (mutable || optIn));
      if (r.locked) {
        check(`${id}: locked — overrides cannot change any channel`,
          (["IN_APP", "EMAIL"] as const).every((ch) => resolveChannelEnabled(r, ch, allOff) === r.defaultChannels.includes(ch)));
      }
      if (mutable && def.protected) canMuteInApp.push(id);
    }
    check("the ONLY protected entries a user can mute today are the pinned gaps (AUDIT R-2)",
      canMuteInApp.sort().join() === Object.keys(KNOWN_SUPPRESSIBILITY_GAPS).sort().join(), canMuteInApp);
    check("FINDING pinned: SECURITY_ANOMALY_DETECTED is muted by PLATFORM IN_APP off",
      resolveChannelEnabled(NOTIFICATION_REGISTRY.SECURITY_ANOMALY_DETECTED, "IN_APP", [{ category: "PLATFORM", channel: "IN_APP", enabled: false }]) === false);
    check("FINDING pinned: SYNC_FAILED email is lost when FINANCIAL IN_APP is off (create.ts returns skipped before the email leg)",
      resolveChannelEnabled(NOTIFICATION_REGISTRY.SYNC_FAILED, "IN_APP", [{ category: "FINANCIAL", channel: "IN_APP", enabled: false }]) === false &&
      /if \(!resolveChannelEnabled\(def, "IN_APP", overrides\)\) \{\s*return \{ status: "skipped" \};/.test(read("lib/notifications/create.ts")));

    // Every direct leg is unconditional: no direct-send source reads a preference.
    const directSources = new Set(defs.flatMap((d) => (d.channels.some((c) => c.path === "DIRECT") ? d.trigger.sources : [])));
    for (const f of directSources) {
      check(`${f}: a direct send reads no notification preference`, !/notificationPreference|isChannelEnabledForUser|resolveChannelEnabled/.test(stripComments(read(f))));
    }
  }
}

async function preferenceWrites(): Promise<void> {
  console.log("4. the settings write path (real setNotificationPreference, fake client)");
  const writes: string[] = [];
  const client = {
    notificationPreference: {
      findMany: async () => [],
      upsert: async (a: { create: { category: string; channel: string } }) => { writes.push(`${a.create.category}:${a.create.channel}`); return { id: "x" }; },
    },
  } as unknown as PreferenceClient;
  const sec = await setNotificationPreference("u-preview", "ACCOUNT_SECURITY", "IN_APP", false, { client });
  check("ACCOUNT_SECURITY cannot be turned off (refused, nothing written)", sec.ok === false && writes.length === 0);
  const plat = await setNotificationPreference("u-preview", "PLATFORM", "IN_APP", false, { client });
  check("FINDING: PLATFORM IN_APP (the Security Ops bell's category) CAN be turned off", plat.ok === true && writes.includes("PLATFORM:IN_APP"));
  for (const d of defs.filter((x) => x.notificationTypeId && x.protected && !(x.key in KNOWN_SUPPRESSIBILITY_GAPS))) {
    const r = NOTIFICATION_REGISTRY[d.notificationTypeId!];
    const before = writes.length;
    const res = await setNotificationPreference("u-preview", r.category, "IN_APP", false, { client });
    check(`${d.key}: its category's IN_APP preference write is refused`, res.ok === false && writes.length === before);
  }
}

main();
preferenceWrites().then(() => {
  console.log(failures === 0 ? "\nAll notification catalog checks passed." : `\n${failures} failure(s).`);
  process.exit(failures === 0 ? 0 : 1);
});
