"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Search, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export type FilterSpec =
  | { name: string; label: string; kind: "select"; options: { value: string; label: string }[]; allLabel?: string }
  | { name: string; label: string; kind: "date" }
  | { name: string; label: string; kind: "search"; placeholder?: string }
  | { name: string; label: string; kind: "toggle"; onLabel: string; offLabel: string };

const ALL = "__all__";

/**
 * URL-driven filters: current values come from the server page as props and
 * every change pushes new search params (page resets to 1).
 */
export function FilterBar({
  basePath,
  filters,
  values,
}: {
  basePath: string;
  filters: FilterSpec[];
  values: Record<string, string | undefined>;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const searchSpec = filters.find((f) => f.kind === "search");
  const [q, setQ] = useState(searchSpec ? (values[searchSpec.name] ?? "") : "");

  const push = (patch: Record<string, string | undefined>) => {
    const next = { ...values, ...patch };
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(next)) if (v) qs.set(k, v);
    qs.delete("page");
    const s = qs.toString();
    startTransition(() => router.push(s ? `${basePath}?${s}` : basePath));
  };

  const active = filters.some((f) => values[f.name]);

  return (
    <div className="mb-4 flex flex-col gap-3" aria-busy={pending || undefined}>
      {searchSpec ? (
        <form
          role="search"
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            push({ [searchSpec.name]: q.trim() || undefined });
          }}
        >
          <Input
            aria-label={searchSpec.label}
            className="h-11 flex-1"
            value={q}
            placeholder={searchSpec.kind === "search" ? searchSpec.placeholder : undefined}
            onChange={(e) => setQ(e.target.value)}
            inputMode="search"
          />
          <Button type="submit" className="h-11" aria-label="Search">
            <Search />
          </Button>
        </form>
      ) : null}
      <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-end">
        {filters.map((f) => {
          const id = `flt-${f.name}`;
          if (f.kind === "search") return null;
          if (f.kind === "select") {
            return (
              <div key={f.name} className="flex flex-col gap-1 sm:w-48">
                <Label htmlFor={id} className="text-xs text-muted-foreground">
                  {f.label}
                </Label>
                <Select value={values[f.name] ?? ALL} onValueChange={(v) => push({ [f.name]: v === ALL ? undefined : v })}>
                  <SelectTrigger id={id} className="h-11 w-full sm:h-9">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ALL}>{f.allLabel ?? "All"}</SelectItem>
                    {f.options.map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            );
          }
          if (f.kind === "toggle") {
            const on = values[f.name] === "1";
            return (
              <div key={f.name} className="flex flex-col gap-1 sm:w-48">
                <span className="text-xs text-muted-foreground">{f.label}</span>
                <Button
                  type="button"
                  variant={on ? "default" : "outline"}
                  className="h-11 sm:h-9"
                  aria-pressed={on}
                  onClick={() => push({ [f.name]: on ? undefined : "1" })}
                >
                  {on ? f.onLabel : f.offLabel}
                </Button>
              </div>
            );
          }
          return (
            <div key={f.name} className="flex flex-col gap-1 sm:w-44">
              <Label htmlFor={id} className="text-xs text-muted-foreground">
                {f.label}
              </Label>
              <Input
                id={id}
                type="date"
                className="h-11 sm:h-9"
                value={values[f.name] ?? ""}
                onChange={(e) => push({ [f.name]: e.target.value || undefined })}
              />
            </div>
          );
        })}
        {active ? (
          <Button
            type="button"
            variant="ghost"
            className="h-11 self-end sm:h-9"
            onClick={() => {
              setQ("");
              startTransition(() => router.push(basePath));
            }}
          >
            <X /> Clear
          </Button>
        ) : null}
      </div>
    </div>
  );
}
