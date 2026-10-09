"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Bell, CheckCheck, Loader2 } from "lucide-react";
import { useCallback, useEffect, useState, useTransition } from "react";

import {
  listNotificationsAction,
  markAllNotificationsReadAction,
  markNotificationsReadAction,
  unreadNotificationCountAction,
} from "@/actions/notifications";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

/**
 * Header bell (P4-D): unread badge + dropdown with the newest 10, mark-all-read
 * and a link to /alerts. Light polling only — unread count on mount, on window
 * focus and every 2 minutes; the list loads each time the dropdown opens.
 */

type Item = {
  id: string;
  title: string;
  body: string | null;
  link: string | null;
  readAt: string | null;
  createdAt: string;
};

const POLL_MS = 120_000;

function safeHref(link: string | null): string | null {
  return link && link.startsWith("/") && !link.startsWith("//") ? link : null;
}

function timeAgo(iso: string): string {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

export function NotificationBell({ className }: { className?: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const [items, setItems] = useState<Item[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [pending, startTransition] = useTransition();

  const refreshCount = useCallback(async () => {
    try {
      const res = await unreadNotificationCountAction({});
      if (res.ok) setUnread(res.data.unread);
    } catch {
      // offline / transient — keep the last known count
    }
  }, []);

  const loadList = useCallback(async () => {
    setLoading(true);
    try {
      const res = await listNotificationsAction({ pageSize: 10 });
      if (res.ok) {
        setItems(res.data.rows);
        setUnread(res.data.unread);
      }
    } catch {
      // keep whatever was shown
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Async poll: setState happens after the awaited action, not synchronously in the effect.
    const tick = () => void refreshCount();
    const first = window.setTimeout(tick, 0);
    const id = window.setInterval(tick, POLL_MS);
    window.addEventListener("focus", tick);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(id);
      window.removeEventListener("focus", tick);
    };
  }, [refreshCount]);

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) void loadList();
  };

  const markAll = () =>
    startTransition(async () => {
      try {
        const res = await markAllNotificationsReadAction({});
        if (res.ok) {
          const now = new Date().toISOString();
          setItems((xs) => xs?.map((x) => ({ ...x, readAt: x.readAt ?? now })) ?? xs);
          setUnread(0);
          router.refresh();
        }
      } catch {
        // ignore; the next open reloads
      }
    });

  const openItem = (item: Item) => {
    const href = safeHref(item.link);
    setOpen(false);
    startTransition(async () => {
      if (!item.readAt) {
        try {
          const res = await markNotificationsReadAction({ ids: [item.id] });
          if (res.ok && res.data.updated > 0) setUnread((n) => Math.max(0, n - 1));
        } catch {
          // ignore
        }
      }
      if (href) router.push(href);
    });
  };

  const badge = unread > 99 ? "99+" : String(unread);

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className={cn("relative shrink-0", className)}
          aria-label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"}
        >
          <Bell className="size-5" />
          {unread > 0 ? (
            <span
              aria-hidden
              className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold leading-none text-white"
            >
              {badge}
            </span>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[min(22rem,calc(100vw-2rem))] gap-0 p-0">
        <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
          <p className="text-sm font-medium">Notifications</p>
          {unread > 0 ? (
            <Button variant="ghost" size="sm" className="h-8" disabled={pending} onClick={markAll}>
              <CheckCheck /> Mark all read
            </Button>
          ) : null}
        </div>
        <div className="max-h-[60dvh] overflow-y-auto">
          {items === null && loading ? (
            <div className="flex items-center justify-center gap-2 px-3 py-6 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Loading…
            </div>
          ) : items === null ? (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">Couldn&apos;t load notifications.</p>
          ) : items.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">No notifications yet.</p>
          ) : (
            <ul className="divide-y">
              {items.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    onClick={() => openItem(item)}
                    className={cn(
                      "flex w-full flex-col gap-0.5 px-3 py-2.5 text-left hover:bg-accent/50",
                      item.readAt ? "" : "bg-accent/30",
                    )}
                  >
                    <span className={cn("text-sm", item.readAt ? "text-muted-foreground" : "font-semibold")}>
                      {!item.readAt ? (
                        <span className="mr-1.5 inline-block size-2 rounded-full bg-primary align-middle" aria-label="Unread" />
                      ) : null}
                      {item.title}
                    </span>
                    {item.body ? <span className="line-clamp-2 text-xs text-muted-foreground">{item.body}</span> : null}
                    <span className="text-[11px] text-muted-foreground">{timeAgo(item.createdAt)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="border-t p-1">
          <Button asChild variant="ghost" className="h-10 w-full" onClick={() => setOpen(false)}>
            <Link href="/alerts">View all alerts</Link>
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
