"use client";

import { useEffect } from "react";

import { startSyncLoop } from "./sync-client";

/**
 * App-wide sync bootstrap: refreshes the refData snapshot on load and flushes
 * the outbox on every `online` event. Mount once (e.g. in AppShell); the
 * offline-capable forms also start the loop through OutboxIndicator.
 */
export function OfflineBoot() {
  useEffect(() => startSyncLoop(), []);
  return null;
}
