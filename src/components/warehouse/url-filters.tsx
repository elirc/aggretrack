"use client";

import { useTransition } from "react";
import { usePathname, useRouter } from "next/navigation";
import { X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

/**
 * URL-driven filter bar: each control writes a search param and the server
 * page re-reads. Current values come from the server (no useSearchParams).
 */

const ALL = "__all";

export type FilterSpec =
  | {
      kind: "select";
      param: string;
      label: string;
      allLabel: string;
      options: { value: string; label: string }[];
    }
  | { kind: "date"; param: string; label: string };

export function UrlFilters({
  filters,
  current,
  chips,
}: {
  filters: FilterSpec[];
  /** Current param values (server-parsed). */
  current: Record<string, string | undefined>;
  /** Extra active params shown as removable chips (e.g. a lot from the lot page). */
  chips?: { param: string; label: string }[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [pending, startTransition] = useTransition();

  const push = (next: Record<string, string | undefined>) => {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(next)) if (v) sp.set(k, v);
    sp.delete("page");
    const qs = sp.toString();
    startTransition(() => router.push(qs ? `${pathname}?${qs}` : pathname));
  };
  const set = (param: string, value: string | undefined) => push({ ...current, [param]: value });

  const active = Object.entries(current).some(([k, v]) => v && k !== "page");

  return (
    <div className="mb-4 flex flex-col gap-3" aria-busy={pending || undefined}>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {filters.map((f) => {
          const id = `flt-${f.param}`;
          if (f.kind === "date") {
            return (
              <div key={f.param} className="flex flex-col gap-1.5">
                <Label htmlFor={id}>{f.label}</Label>
                <Input
                  id={id}
                  type="date"
                  className="h-11 sm:h-9"
                  value={current[f.param] ?? ""}
                  onChange={(e) => set(f.param, e.target.value || undefined)}
                />
              </div>
            );
          }
          return (
            <div key={f.param} className="flex flex-col gap-1.5">
              <Label htmlFor={id}>{f.label}</Label>
              <Select
                value={current[f.param] ?? ALL}
                onValueChange={(v) => set(f.param, v === ALL ? undefined : v)}
              >
                <SelectTrigger id={id} className="h-11 w-full sm:h-9">
                  <SelectValue placeholder={f.allLabel} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>{f.allLabel}</SelectItem>
                  {f.options.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          );
        })}
      </div>
      {chips?.length || active ? (
        <div className="flex flex-wrap items-center gap-2">
          {chips?.map((c) => (
            <Button
              key={c.param}
              variant="secondary"
              size="sm"
              className="h-9"
              onClick={() => set(c.param, undefined)}
              aria-label={`Remove filter ${c.label}`}
            >
              {c.label} <X />
            </Button>
          ))}
          {active ? (
            <Button variant="ghost" size="sm" className="h-9" onClick={() => push({})}>
              Clear filters
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Prev/next pager writing ?page=. */
export function UrlPager({
  page,
  pageSize,
  total,
  current,
}: {
  page: number;
  pageSize: number;
  total: number;
  current: Record<string, string | undefined>;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages <= 1) return null;
  const go = (p: number) => {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(current)) if (v && k !== "page") sp.set(k, v);
    if (p > 1) sp.set("page", String(p));
    const qs = sp.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname);
  };
  return (
    <div className="mt-4 flex items-center justify-between gap-2 text-sm">
      <Button variant="outline" className="h-11 sm:h-9" disabled={page <= 1} onClick={() => go(page - 1)}>
        Previous
      </Button>
      <span className="text-muted-foreground">
        Page {page} of {pages} · {total.toLocaleString("en-NG")} rows
      </span>
      <Button variant="outline" className="h-11 sm:h-9" disabled={page >= pages} onClick={() => go(page + 1)}>
        Next
      </Button>
    </div>
  );
}
