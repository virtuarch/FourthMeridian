import Image from "next/image";
import ui from "./ui.module.css";

/**
 * Fourth Meridian mark + wordmark. The site is always dark, so it uses the dark
 * mark directly. The image is a 128 px derivative of the app's
 * public/fm-mark-dark.png (1254 px, 1.4 MB); see site/README.md for how it was made.
 */
export function Wordmark({ size = 30 }: { size?: number }) {
  return (
    <span className={ui.wordmark}>
      <Image src="/brand/fm-mark-dark-128.png" alt="Fourth Meridian" width={size} height={size} className={ui.wordmarkImage} priority />
      <span className={ui.wordmarkText}>Fourth Meridian</span>
    </span>
  );
}
