"use client";

import { useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Play, RotateCcw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { ReportKey } from "@/lib/validation/logistics";

import { REPORT_DEFS, toQuery, type EntityKind } from "./definitions";

const ALL = "__all";

export type EntityOptions = Partial<Record<EntityKind, { value: string; label: string }[]>>;

/**
 * Filter controls for one report. Submitting writes the params to the URL;
 * the server page re-parses them and runs the report, so links are shareable.
 */
export function ReportFilters({
  report,
  current,
  options,
  fieldErrors,
}: {
  report: ReportKey;
  /** Server-parsed raw params (defaults filled). */
  current: Record<string, string>;
  options: EntityOptions;
  fieldErrors?: Record<string, string[]>;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [values, setValues] = useState<Record<string, string>>(current);
  const def = REPORT_DEFS[report];

  const set = (param: string, v: string | undefined) =>
    setValues((prev) => {
      const next = { ...prev };
      if (v) next[param] = v;
      else delete next[param];
      return next;
    });

  const go = (params: Record<string, string>) => {
    const qs = toQuery(params);
    startTransition(() => router.push(qs ? `/reports/${report}?${qs}` : `/reports/${report}`));
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    go(values);
  };

  return (
    <form onSubmit={onSubmit} className="mb-4 flex flex-col gap-3 rounded-lg border p-3" aria-busy={pending || undefined}>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {def.fields.map((f) => {
          if (f.kind === "hidden") return null;
          const id = `rf-${f.param}`;
          const err = fieldErrors?.[f.param]?.[0];
          let control;
          if (f.kind === "date") {
            control = (
              <Input
                id={id}
                type="date"
                required
                className="h-11 sm:h-9"
                value={values[f.param] ?? ""}
                onChange={(e) => set(f.param, e.target.value || undefined)}
                aria-invalid={err ? true : undefined}
              />
            );
          } else {
            const opts = f.kind === "entity" ? (options[f.entity] ?? []) : f.options;
            const allLabel = f.allLabel;
            const hasAll = f.kind === "entity" || !f.defaultValue;
            control = (
              <Select
                value={values[f.param] ?? (hasAll ? ALL : undefined)}
                onValueChange={(v) => set(f.param, v === ALL ? undefined : v)}
              >
                <SelectTrigger id={id} className="h-11 w-full sm:h-9" aria-invalid={err ? true : undefined}>
                  <SelectValue placeholder={allLabel ?? "Choose"} />
                </SelectTrigger>
                <SelectContent>
                  {hasAll ? <SelectItem value={ALL}>{allLabel ?? "All"}</SelectItem> : null}
                  {opts.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            );
          }
          return (
            <div key={f.param} className="flex flex-col gap-1.5">
              <Label htmlFor={id}>{f.label}</Label>
              {control}
              {err ? <p className="text-xs text-destructive">{err}</p> : null}
            </div>
          );
        })}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" className="h-11 sm:h-9" disabled={pending}>
          {pending ? <Loader2 className="animate-spin" /> : <Play />}
          Run report
        </Button>
        <Button
          type="button"
          variant="ghost"
          className="h-11 sm:h-9"
          disabled={pending}
          onClick={() => {
            setValues({});
            go({});
          }}
        >
          <RotateCcw />
          Reset
        </Button>
      </div>
    </form>
  );
}
