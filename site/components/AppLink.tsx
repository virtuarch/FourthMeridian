"use client";

import { useSyncExternalStore, type AnchorHTMLAttributes, type ReactNode } from "react";
import { withAcquisition } from "@site/lib/acquisition";

/**
 * A plain top-level link into the application that FORWARDS acquisition
 * context (lib/acquisition.ts): the allowlisted utm_* / ref / source query
 * keys from the current page URL and the site path the visitor is on.
 *
 * Server-rendered as the exact build-time href (so the static export and a
 * no-JavaScript visitor get a working link), then re-pointed from
 * `window.location` once hydrated — through useSyncExternalStore, whose server
 * snapshot IS the build-time href, so hydration matches and the browser value
 * takes over in the same commit. It never reads a cookie, storage or the
 * network, never knows whether the visitor is signed in, and the destination
 * ORIGIN is always the one `href` arrived with.
 */
export interface AppLinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> {
  href: string;
  children: ReactNode;
}

/** The URL never changes without a full navigation on a static site, so there is nothing to subscribe to. */
const subscribe = () => () => {};

export function AppLink({ href, children, ...rest }: AppLinkProps) {
  const resolved = useSyncExternalStore(
    subscribe,
    () => withAcquisition(href, window.location.search, window.location.pathname),
    () => href,
  );
  return <a {...rest} href={resolved}>{children}</a>;
}
