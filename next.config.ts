import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV === "development";

// Extra LAN IPs or hostnames allowed to access the dev server (e.g. a phone
// on your local network). Comma-separated in DEV_ALLOWED_ORIGINS.
// Only applied in development — allowedDevOrigins has no effect in production
// and emits a warning if set there.
const extraOrigins = isDev && process.env.DEV_ALLOWED_ORIGINS
  ? process.env.DEV_ALLOWED_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean)
  : [];

const nextConfig: NextConfig = {
  ...(isDev && {
    allowedDevOrigins: ["127.0.0.1", "localhost", ...extraOrigins],
  }),
};

export default nextConfig;
