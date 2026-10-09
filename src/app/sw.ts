/// <reference lib="webworker" />
import { defaultCache } from "@serwist/next/worker";
import type { PrecacheEntry, SerwistGlobalConfig } from "serwist";
import { NetworkOnly, Serwist } from "serwist";

/**
 * Service worker (INTEGRATIONS §5). Built by @serwist/next into public/sw.js
 * during `next build --webpack`; disabled in dev.
 *
 * - Precache: the build manifest + the /~offline fallback page.
 * - Runtime: /api/sync is network-only (never serve another session's
 *   reference data or replay a cached sync); everything else uses Serwist's
 *   defaultCache (pages network-first, static assets cache-first, …).
 * - Navigations that fail with no cached copy fall back to /~offline.
 */

declare global {
  interface WorkerGlobalScope extends SerwistGlobalConfig {
    __SW_MANIFEST: (PrecacheEntry | string)[] | undefined;
  }
}

declare const self: ServiceWorkerGlobalScope;

const OFFLINE_URL = "/~offline";

const serwist = new Serwist({
  precacheEntries: [...(self.__SW_MANIFEST ?? []), { url: OFFLINE_URL, revision: "offline-v1" }],
  skipWaiting: true,
  clientsClaim: true,
  navigationPreload: true,
  runtimeCaching: [
    {
      matcher: ({ sameOrigin, url }) => sameOrigin && url.pathname.startsWith("/api/sync"),
      handler: new NetworkOnly(),
    },
    ...defaultCache,
  ],
  fallbacks: {
    entries: [
      {
        url: OFFLINE_URL,
        matcher({ request }) {
          return request.destination === "document";
        },
      },
    ],
  },
});

serwist.addEventListeners();
