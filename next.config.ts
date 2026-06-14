import type { NextConfig } from "next";

// Extra LAN IPs or hostnames allowed to access the dev server (e.g. a phone
// on your local network). Comma-separated in DEV_ALLOWED_ORIGINS.
// "127.0.0.1" and "localhost" are always included.
const extraOrigins = process.env.DEV_ALLOWED_ORIGINS
  ? process.env.DEV_ALLOWED_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean)
  : [];

const nextConfig: NextConfig = {
  allowedDevOrigins: ["127.0.0.1", "localhost", ...extraOrigins],
};

export default nextConfig;
