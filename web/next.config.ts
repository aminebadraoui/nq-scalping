import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Dev double-mounts every effect in StrictMode, which created two live
  // lightweight-charts instances (and two WebSocket/SSE subscribers) inside the
  // same container — one chart drawn over the other, which is exactly the kind
  // of visual "squish" that is impossible to debug. This is a local tool, so
  // the trade-off (losing the dev-only double-invoke checks) is worth it.
  reactStrictMode: false,
  // standalone server bundle for the Docker image (server.js + .next/standalone)
  output: "standalone",
};

export default nextConfig;
