"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  Bell,
  CheckCheck,
  ClipboardCheck,
  Hourglass,
  Info,
  PackageMinus,
  Wallet,
  Warehouse,
  type LucideIcon,
} from "lucide-react";

import { runAction } from "@/components/logistics/run-action";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { markAllNotificationsReadAction, markNotificationReadAction } from "../actions";

export type AlertItem = {
  id: string;
  type: "low_stock" | "old_stock" | "capacity" | "approval_request" | "payment" | "system";
  title: string;
  body: string | null;
  link: string | null;
  read: boolean;
  when: string;
};

const TYPE_META: Record<AlertItem["type"], { icon: LucideIcon; label: string }> = {
  low_stock: { icon: PackageMinus, label: "Low stock" },
  old_stock: { icon: Hourglass, label: "Old stock" },
  capacity: { icon: Warehouse, label: "Near capacity" },
  approval_request: { icon: ClipboardCheck, label: "Approval" },
  payment: { icon: Wallet, label: "Payment" },
  system: { icon: Info, label: "System" },
};

/** Only in-app paths are navigable (no external / protocol-relative links). */
function safeHref(link: string | null): string | null {
  return link && link.startsWith("/") && !link.startsWith("//") ? link : null;
}

export function AlertsList({ items, unread }: { items: AlertItem[]; unread: number }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const markRead = (id: string) =>
    startTransition(async () => {
      const ok = await runAction(markNotificationReadAction, { id });
      if (ok) router.refresh();
    });

  const open = (item: AlertItem) => {
    const href = safeHref(item.link);
    startTransition(async () => {
      if (!item.read) await runAction(markNotificationReadAction, { id: item.id });
      if (href) router.push(href);
      else router.refresh();
    });
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground" aria-live="polite">
          {unread === 0 ? "All caught up." : `${unread} unread`}
        </p>
        {unread > 0 ? (
          <Button
            variant="outline"
            className="h-11 sm:h-9"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                const ok = await runAction(markAllNotificationsReadAction, {}, "All alerts marked read");
                if (ok) router.refresh();
              })
            }
          >
            <CheckCheck /> Mark all read
          </Button>
        ) : null}
      </div>
      <ul className="divide-y overflow-hidden rounded-lg border">
        {items.map((item) => {
          const meta = TYPE_META[item.type] ?? { icon: Bell, label: item.type };
          const Icon = meta.icon;
          const href = safeHref(item.link);
          return (
            <li
              key={item.id}
              className={cn("flex items-start gap-3 px-3 py-3", item.read ? "bg-background" : "bg-accent/40")}
            >
              <span
                className={cn(
                  "mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full border",
                  item.read ? "text-muted-foreground" : "text-foreground",
                )}
                title={meta.label}
              >
                <Icon className="size-4" aria-hidden />
                <span className="sr-only">{meta.label}</span>
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-start justify-between gap-2">
                  <p className={cn("text-sm", item.read ? "text-muted-foreground" : "font-semibold")}>
                    {!item.read ? <span className="mr-1.5 inline-block size-2 rounded-full bg-primary align-middle" aria-label="Unread" /> : null}
                    {item.title}
                  </p>
                  <time className="shrink-0 text-xs text-muted-foreground">{item.when}</time>
                </div>
                {item.body ? <p className="mt-0.5 text-sm text-muted-foreground">{item.body}</p> : null}
                <div className="mt-2 flex flex-wrap gap-2">
                  {href ? (
                    <Button size="sm" variant="secondary" className="h-9" disabled={pending} onClick={() => open(item)}>
                      Open
                    </Button>
                  ) : null}
                  {!item.read ? (
                    <Button size="sm" variant="ghost" className="h-9" disabled={pending} onClick={() => markRead(item.id)}>
                      Mark read
                    </Button>
                  ) : null}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
