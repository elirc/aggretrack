import type { NextConfig } from "next";
import withSerwistInit from "@serwist/next";

// Serwist's webpack plugin builds the service worker, so production builds run
// `next build --webpack` (see package.json). Dev uses Turbopack with the SW
// disabled.
const withSerwist = withSerwistInit({
  swSrc: "src/app/sw.ts",
  swDest: "public/sw.js",
  disable: process.env.NODE_ENV === "development",
  // The offline outbox handles reconnects itself; Serwist's default
  // reload-on-online would wipe in-page queue state mid-sync.
  reloadOnOnline: false,
});

const nextConfig: NextConfig = {
  serverExternalPackages: ["@react-pdf/renderer", "pg", "pg-boss", "exceljs"],
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default withSerwist(nextConfig);
