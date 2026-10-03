import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";
import { PUBLIC_CONFIG } from "./lib/public-config";

// Importing PUBLIC_CONFIG validates the public origins before anything is built:
// a production build with a missing / non-HTTPS / Production-in-Preview origin
// fails here, not after emitting links (lib/public-config.ts).
void PUBLIC_CONFIG;

// THIS DIRECTORY IS THE WHOLE PROJECT. The repository root holds the financial
// application and its own lockfile; Next 16 infers the workspace root from the
// top-most lockfile it finds, which would make the app part of this build's
// graph. Pin both roots here so nothing above site/ is traced, watched or bundled.
const SITE_ROOT = path.dirname(fileURLToPath(import.meta.url));
// Next transpiles this file before loading it; refuse to build if that ever
// moves import.meta.url away from site/ (a wrong root would be silent otherwise).
if (!existsSync(path.join(SITE_ROOT, "lib", "public-config.ts"))) {
  throw new Error(`[site] next.config.ts resolved its root to ${SITE_ROOT}, which is not site/`);
}

const nextConfig: NextConfig = {
  // Static HTML export: no server runtime, no route handlers, no middleware, no
  // image optimizer. A compromised deployment can serve wrong pages and nothing else.
  output: "export",
  images: { unoptimized: true },
  poweredByHeader: false,
  reactStrictMode: true,
  turbopack: { root: SITE_ROOT },
  outputFileTracingRoot: SITE_ROOT,
};

export default nextConfig;
