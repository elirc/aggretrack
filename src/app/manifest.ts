import type { MetadataRoute } from "next";

/** Web app manifest — served by Next at /manifest.webmanifest (referenced from the root layout). */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "AggreTrack",
    short_name: "AggreTrack",
    description: "Buying, warehousing and sales tracking for agricultural aggregators.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#ffffff",
    theme_color: "#16a34a",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
