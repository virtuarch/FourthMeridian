/**
 * lib/notifications/content/send.ts  (Comms Center B1 — what a send renders, contract v1.1 §5.3, §5.4)
 *
 * Called by createNotification (lib/notifications/create.ts) for every
 * registry type. For a type with no content-editable leg it returns at once —
 * no read. For an editable leg it asks the resolver for the PUBLISHED version
 * of the stream the render data selects; with none (or any failure) the
 * registry render is used exactly as before, and the leg is recorded with no
 * contentVersionId.
 *
 *   IN_APP  the substituted subject → Notification.title, the paragraph → body,
 *           the cta label → actionLabel; href / icon / category / priority /
 *           dedupe stay the registry's.
 *   EMAIL   the substituted content for the `notification` template, every URL
 *           from the trusted app base + the registry href. The email leg never
 *           inherits the in-app version: each channel is its own stream.
 */

import type { NotificationRenderData, RenderedNotification } from "@/lib/notifications/types";
import type { NotificationEmailContent } from "@/lib/email/templates/notification";
import { legSpec, variantFor, type LegSpec } from "./legs";
import { hasErrors, validateContent } from "./validate";
import { emailContent, inAppRender, textValues } from "./render";
import type { ContentBody, ContentStreamRef } from "./types";
import { getNotificationDefinition } from "@/lib/notifications/registry";
import { EMAIL_ANCHOR_MARKER } from "@/lib/notifications/email-anchor";

/** The published version of one stream, as the send path needs it. */
export interface LiveVersion { versionId: string; body: ContentBody }
/** Resolves the live (published) version of a stream; null = the code default. Never throws. */
export type LiveContentResolver = (stream: ContentStreamRef) => Promise<LiveVersion | null>;

export interface LiveRender {
  /** The in-app render to store, and the version it came from (null = the code default). */
  inApp: { rendered: RenderedNotification; contentVersionId: string | null };
  /** The published EMAIL content, or null for the code rendering. */
  email: { versionId: string; content: NotificationEmailContent } | null;
}

export async function liveRenderFor(args: {
  type: string;
  data: NotificationRenderData;
  codeRendered: RenderedNotification;
  resolver: LiveContentResolver | null;
  appBaseUrl: string | undefined;
  log?: (line: string) => void;
}): Promise<LiveRender> {
  const log = args.log ?? ((l: string) => console.warn(l));
  const out: LiveRender = { inApp: { rendered: args.codeRendered, contentVersionId: null }, email: null };
  if (!args.resolver) return out;
  const resolver = args.resolver;
  const variant = variantFor(args.type, args.data);
  // A resolver is contracted never to throw; this guard makes that a property of the send path too.
  const resolve = async (channel: "IN_APP" | "EMAIL") => {
    try { return await resolver({ definitionKey: args.type, channel, variant }); }
    catch { log(`[comms-content] live content unreadable; the code default is used: type=${args.type} channel=${channel}`); return null; }
  };

  /**
   * Review P3 — SEND-TIME REVALIDATION: the published body is re-validated under
   * the CURRENT validator before it is rendered; any error (a rule that tightened,
   * a stored row that no longer fits its allowlist) is RENDER_FALLBACK to the code
   * template. And the rendered output is never allowed to carry a literal "{{" /
   * "}}": that is RENDER_FALLBACK too. Log lines carry ids only.
   */
  const usable = (spec: LegSpec, live: LiveVersion, channel: "IN_APP" | "EMAIL"): boolean => {
    const issues = validateContent(spec, live.body, { mode: "manual", baseline: spec.codeDefault(variant), variant });
    if (!hasErrors(issues)) return true;
    log(`[comms-content] RENDER_FALLBACK type=${args.type} channel=${channel} version=${live.versionId} reason=INVALID codes=${[...new Set(issues.filter((i) => i.severity === "error").map((i) => i.code))].join(",")}`);
    return false;
  };
  const braceFree = (v: unknown) => !/\{\{|\}\}/.test(JSON.stringify(v));

  const inAppSpec = legSpec(args.type, "IN_APP");
  if (inAppSpec && inAppSpec.variants.includes(variant)) {
    const live = await resolve("IN_APP");
    if (live && usable(inAppSpec, live, "IN_APP")) {
      try {
        const rendered = inAppRender(inAppSpec, live.body, textValues(inAppSpec, args.data), variant);
        if (!braceFree(rendered)) throw new Error("unresolved placeholder");
        out.inApp = { rendered, contentVersionId: live.versionId };
      } catch {
        log(`[comms-content] RENDER_FALLBACK type=${args.type} channel=IN_APP version=${live.versionId}`);
      }
    }
  }

  const emailSpec = legSpec(args.type, "EMAIL");
  if (emailSpec && emailSpec.variants.includes(variant)) {
    const live = await resolve("EMAIL");
    if (live && usable(emailSpec, live, "EMAIL")) {
      try {
        const content = emailContent(emailSpec, live.body, textValues(emailSpec, args.data), variant, args.appBaseUrl);
        if (!braceFree(content)) throw new Error("unresolved placeholder");
        out.email = { versionId: live.versionId, content };
      } catch {
        log(`[comms-content] RENDER_FALLBACK type=${args.type} channel=EMAIL version=${live.versionId}`);
      }
    }
  }
  return out;
}

/**
 * Review P2 — the EMAIL leg of a RETRY. The Notification row stores the IN-APP
 * render (possibly a published in-app version), so a retry must not build the
 * email from it: for a type with a content-editable leg it re-renders from the
 * stored render data — the registry render for the code fields, plus the
 * EMAIL stream's PUBLISHED version (re-validated, as at create time) — so the
 * retried email carries the email copy and its contentVersionId. Types with no
 * editable leg, and rows with no render data, keep the stored copy exactly.
 */
export async function retryEmailParts(args: {
  type: string;
  metadata: unknown;
  stored: { title: string; body: string | null; href: string | null };
  resolver: LiveContentResolver | null;
  appBaseUrl: string | undefined;
  log?: (line: string) => void;
}): Promise<{ title: string; body: string | null; href: string | null; emailContent?: LiveRender["email"] & object }> {
  const editable = legSpec(args.type, "EMAIL") !== undefined || legSpec(args.type, "IN_APP") !== undefined;
  const reg = getNotificationDefinition(args.type);
  const md = args.metadata;
  if (!editable || !reg || typeof md !== "object" || md === null || Array.isArray(md)) return { ...args.stored };
  const data = Object.fromEntries(Object.entries(md as Record<string, unknown>).filter(([k]) => k !== EMAIL_ANCHOR_MARKER));
  const code = reg.render(data);
  const live = await liveRenderFor({ type: args.type, data, codeRendered: code, resolver: args.resolver, appBaseUrl: args.appBaseUrl, ...(args.log ? { log: args.log } : {}) });
  return { title: code.title, body: code.body ?? null, href: code.href ?? null, ...(live.email ? { emailContent: live.email } : {}) };
}
