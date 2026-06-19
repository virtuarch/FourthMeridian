"use client";

/**
 * AppLogo
 *
 * Shared Fourth Meridian platform mark — the FinTracker → Fourth Meridian
 * rebrand's single reusable logo component, used anywhere the app shows
 * its own icon and/or wordmark (sidebar, mobile/desktop chrome, auth
 * screens). Generalizes the theme-aware swap pattern already established
 * by components/brief/BriefLogo.tsx (same two assets, same resolvedTheme
 * source) rather than duplicating that logic per call site.
 *
 * Theme handling: by default the mark follows the live Midnight/Light
 * Glass appearance via useTheme(), same hydration-safe default-to-dark
 * behavior as BriefLogo (resolvedTheme is "dark" until the post-mount
 * localStorage read completes, so server render and first paint agree).
 *
 * `forceTheme` exists for screens that render with a fixed dark
 * background regardless of the user's stored theme preference (the
 * (auth) routes — login/register/forgot-password/reset-password — were
 * built with hardcoded bg-gray-950/text-white Tailwind classes and never
 * adopted theme tokens). On those pages the mark must not follow the live
 * theme, or a Light Glass preference would swap in the light-background
 * mark on top of a backdrop that's always dark. Passing forceTheme="dark"
 * pins it to the dark mark there, independent of the user's real setting.
 *
 * The wordmark is plain text, not baked into the image — unlike the old
 * public/logo-full.png lockup, which had "FinTracker" rendered into the
 * pixels. Keeping it as text means it inherits whatever color the caller
 * passes (theme tokens where the page is theme-aware, a hardcoded color
 * where it isn't) instead of ever needing a re-exported image per brand
 * change.
 */

import Image from "next/image";
import { useTheme } from "@/components/theme/ThemeProvider";

interface AppLogoProps {
  /** Icon size in pixels (square). Default 32. */
  size?: number;
  /** Render the "Fourth Meridian" wordmark next to the icon. */
  withWordmark?: boolean;
  /** Classes for the wordmark text — caller controls color/size/weight beyond the default font-bold. */
  wordmarkClassName?: string;
  /** Extra classes for the icon image itself (sizing is via width/height props, not Tailwind). */
  className?: string;
  /** Pin to a specific mark instead of following the live theme — see file header. */
  forceTheme?: "dark" | "light";
  /** Pass through to next/image for above-the-fold marks (sidebar, auth screens). */
  priority?: boolean;
}

export function AppLogo({
  size = 32,
  withWordmark = false,
  wordmarkClassName = "",
  className = "",
  forceTheme,
  priority = false,
}: AppLogoProps) {
  const { resolvedTheme } = useTheme();
  const theme = forceTheme ?? resolvedTheme;
  const src = theme === "light" ? "/fm-mark-light.png" : "/fm-mark-dark.png";

  return (
    <span className="inline-flex items-center gap-2 min-w-0">
      <Image
        src={src}
        alt="Fourth Meridian"
        width={size}
        height={size}
        className={`rounded-xl object-contain shrink-0 ${className}`}
        priority={priority}
      />
      {withWordmark && (
        <span className={`font-bold truncate ${wordmarkClassName}`}>Fourth Meridian</span>
      )}
    </span>
  );
}
