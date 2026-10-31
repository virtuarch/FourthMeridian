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
import { legSpec, variantFor } from "./legs";
import { emailContent, inAppRender, textValues } from "./render";
import type { ContentBody, ContentStreamRef } from "./types";

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

  const inAppSpec = legSpec(args.type, "IN_APP");
  if (inAppSpec && inAppSpec.variants.includes(variant)) {
    const live = await resolve("IN_APP");
    if (live) {
      try {
        out.inApp = { rendered: inAppRender(inAppSpec, live.body, textValues(inAppSpec, args.data), variant), contentVersionId: live.versionId };
      } catch {
        log(`[comms-content] RENDER_FALLBACK type=${args.type} channel=IN_APP version=${live.versionId}`);
      }
    }
  }

  const emailSpec = legSpec(args.type, "EMAIL");
  if (emailSpec && emailSpec.variants.includes(variant)) {
    const live = await resolve("EMAIL");
    if (live) {
      try {
        out.email = { versionId: live.versionId, content: emailContent(emailSpec, live.body, textValues(emailSpec, args.data), variant, args.appBaseUrl) };
      } catch {
        log(`[comms-content] RENDER_FALLBACK type=${args.type} channel=EMAIL version=${live.versionId}`);
      }
    }
  }
  return out;
}
