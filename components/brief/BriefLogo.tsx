"use client";

/**
 * BriefLogo
 *
 * Theme-aware Fourth Meridian mark for the Daily Brief header. Swaps
 * between the dark and light 4M mark assets based on the resolved
 * appearance (Midnight Glass / Light Glass) from the app-wide
 * ThemeProvider — same "give the caller a resolved value, render it"
 * philosophy as EarthBackground's `theme` prop.
 *
 * Hydration safety: useTheme()'s resolvedTheme defaults to "dark" until
 * the post-mount localStorage read completes (see ThemeProvider.tsx), so
 * server render and the client's first paint both show the dark mark —
 * no mismatch warning, just a possible one-time swap to the light mark
 * shortly after mount if that's the stored/system preference. Identical
 * pattern to EarthBackground.
 *
 * This is a small dedicated client component (rather than converting
 * BriefLayout itself to "use client") so the layout can stay a plain
 * Server Component everywhere else.
 *
 * Glass backing: a small frosted disc sits behind the mark, mirroring
 * UserMenu's avatar circle at the opposite end of the header. With the
 * hero's top vignette deliberately softened (EarthBackground Layer 6c) so
 * more of the globe shows through behind the nav, each control now carries
 * its own light contrast/legibility treatment instead of relying on one
 * heavy page-wide dark band — the pair reads as floating glass controls on
 * the globe rather than sitting on an opaque bar.
 */

import Image from "next/image";
import { useTheme } from "@/components/theme/ThemeProvider";

export function BriefLogo() {
  const { resolvedTheme } = useTheme();
  const isLight = resolvedTheme === "light";
  const src = resolvedTheme === "dark" ? "/fm-mark-dark.png" : "/fm-mark-light.png";

  return (
    <div
      className="w-11 h-11 rounded-full backdrop-blur-sm flex items-center justify-center"
      style={{
        background: isLight ? "rgba(17,21,31,0.06)" : "rgba(255,255,255,0.08)",
        border: "1px solid var(--border-hairline-strong)",
      }}
    >
      <Image
        src={src}
        alt="Fourth Meridian"
        width={30}
        height={30}
        className="rounded-lg"
        priority
      />
    </div>
  );
}
