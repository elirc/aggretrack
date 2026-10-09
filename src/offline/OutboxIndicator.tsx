"use client";

import { CloudOff, CloudUpload, RefreshCw, Trash2, TriangleAlert } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

import type { OutboxKind, OutboxRecord } from "./db";
import { useOutbox } from "./useOutbox";

const KIND_LABEL: Record<OutboxKind, string> = {
  purchase: "Purchase",
  receipt: "Receipt",
  dispatch: "Dispatch",
};

function rowLabel(r: OutboxRecord): string {
  return r.label ?? `${KIND_LABEL[r.kind]} · ${new Date(r.createdAt).toLocaleString("en-NG")}`;
}

/**
 * Offline queue status for the offline-capable forms (purchase entry, receive,
 * dispatch): offline / pending / failed counts, the queued list with
 * retry + discard, and a "Sync now" button. Renders nothing when online with
 * an empty queue. Mounting it also starts the sync loop.
 */
export function OutboxIndicator({ kind, className }: { kind?: OutboxKind; className?: string }) {
  const ob = useOutbox({ kind });
  const visible = ob.active;

  if (ob.online && visible.length === 0) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className={`flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-sm ${
        ob.failed > 0
          ? "border-destructive/40 bg-destructive/5"
          : "border-amber-300 bg-amber-50 text-amber-950 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100"
      } ${className ?? ""}`}
    >
      {ob.online ? (
        <CloudUpload className="size-4 shrink-0" aria-hidden />
      ) : (
        <CloudOff className="size-4 shrink-0" aria-hidden />
      )}
      <span className="min-w-0 flex-1">
        {!ob.online ? "You are offline. " : null}
        {ob.pending > 0 ? `${ob.pending} queued — will sync` : visible.length === 0 ? "Saves will be queued." : null}
        {ob.pending > 0 && ob.failed > 0 ? " · " : null}
        {ob.failed > 0 ? <span className="font-medium text-destructive">{ob.failed} failed</span> : null}
        {ob.syncing ? " · syncing…" : null}
      </span>

      {visible.length > 0 ? (
        <Popover>
          <PopoverTrigger asChild>
            <Button type="button" variant="outline" size="sm" className="h-9">
              View
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-[min(22rem,calc(100vw-2rem))] p-0">
            <ul className="max-h-80 divide-y overflow-y-auto">
              {visible.map((r) => (
                <li key={r.id} className="flex items-start gap-2 px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{rowLabel(r)}</p>
                    <div className="mt-0.5 flex items-center gap-1.5">
                      <Badge variant={r.status === "failed" ? "destructive" : "secondary"}>
                        {r.status === "failed" ? "Failed" : r.status === "syncing" ? "Syncing" : "Queued"}
                      </Badge>
                      {r.error ? (
                        <span className="truncate text-xs text-muted-foreground" title={r.error}>
                          {r.error}
                        </span>
                      ) : null}
                    </div>
                  </div>
                  {r.status === "failed" ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-9"
                      aria-label="Retry"
                      onClick={() => void ob.retry(r.id)}
                    >
                      <RefreshCw />
                    </Button>
                  ) : null}
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-9"
                    aria-label="Discard"
                    disabled={r.status === "syncing"}
                    onClick={() => {
                      if (window.confirm("Discard this queued entry? It will not be synced.")) void ob.discard(r.id);
                    }}
                  >
                    <Trash2 />
                  </Button>
                </li>
              ))}
            </ul>
            {ob.lastError ? (
              <p className="flex items-center gap-1 border-t px-3 py-2 text-xs text-muted-foreground">
                <TriangleAlert className="size-3.5" /> {ob.lastError}
              </p>
            ) : null}
          </PopoverContent>
        </Popover>
      ) : null}

      {ob.pending > 0 || ob.failed > 0 ? (
        <Button
          type="button"
          size="sm"
          className="h-9"
          disabled={!ob.online || ob.syncing}
          onClick={() => void (ob.failed > 0 ? ob.retryFailed() : ob.syncNow())}
        >
          <RefreshCw className={ob.syncing ? "animate-spin" : undefined} /> Sync now
        </Button>
      ) : null}
    </div>
  );
}

/** Inline "Queued — will sync" badge shown by a form after it queued its submit. */
export function QueuedBadge({ label = "Queued — will sync" }: { label?: string }) {
  return (
    <Badge variant="outline" className="border-amber-400 text-amber-800 dark:text-amber-200">
      <CloudOff /> {label}
    </Badge>
  );
}
