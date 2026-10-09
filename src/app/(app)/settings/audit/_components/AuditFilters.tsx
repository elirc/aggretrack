"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const ALL = "__all";

type Value = { table: string; action: string; from: string; to: string };

function humanise(s: string) {
  return s.replace(/_/g, " ");
}

/** Filter bar (one row on desktop, stacked on phones). Applies via URL params. */
export function AuditFilters({ tables, actions, value }: { tables: string[]; actions: string[]; value: Value }) {
  const router = useRouter();
  const [v, setV] = useState<Value>(value);
  const rangeBad = v.from !== "" && v.to !== "" && v.from > v.to;

  const apply = (next: Value) => {
    const qs = new URLSearchParams();
    if (next.table) qs.set("table", next.table);
    if (next.action) qs.set("action", next.action);
    if (next.from) qs.set("from", next.from);
    if (next.to) qs.set("to", next.to);
    const s = qs.toString();
    router.push(s ? `/settings/audit?${s}` : "/settings/audit");
  };

  return (
    <form
      className="grid grid-cols-2 gap-2 rounded-lg border p-3 sm:grid-cols-[1fr_1fr_auto_auto_auto] sm:items-end"
      onSubmit={(e) => {
        e.preventDefault();
        if (!rangeBad) apply(v);
      }}
    >
      <div className="flex flex-col gap-1">
        <Label htmlFor="audit-table" className="text-xs">
          Table
        </Label>
        <Select value={v.table || ALL} onValueChange={(x) => setV({ ...v, table: x === ALL ? "" : x })}>
          <SelectTrigger id="audit-table" className="h-11 w-full sm:h-9">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All tables</SelectItem>
            {tables.map((t) => (
              <SelectItem key={t} value={t}>
                {humanise(t)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="audit-action" className="text-xs">
          Action
        </Label>
        <Select value={v.action || ALL} onValueChange={(x) => setV({ ...v, action: x === ALL ? "" : x })}>
          <SelectTrigger id="audit-action" className="h-11 w-full sm:h-9">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All actions</SelectItem>
            {actions.map((a) => (
              <SelectItem key={a} value={a} className="capitalize">
                {a}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="audit-from" className="text-xs">
          From
        </Label>
        <Input
          id="audit-from"
          type="date"
          className="h-11 sm:h-9"
          value={v.from}
          onChange={(e) => setV({ ...v, from: e.target.value })}
        />
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="audit-to" className="text-xs">
          To
        </Label>
        <Input
          id="audit-to"
          type="date"
          className="h-11 sm:h-9"
          value={v.to}
          aria-invalid={rangeBad}
          onChange={(e) => setV({ ...v, to: e.target.value })}
        />
      </div>
      <div className="col-span-2 flex gap-2 sm:col-span-1">
        <Button type="submit" className="h-11 flex-1 sm:h-9" disabled={rangeBad}>
          Apply
        </Button>
        <Button
          type="button"
          variant="ghost"
          className="h-11 sm:h-9"
          onClick={() => {
            const empty = { table: "", action: "", from: "", to: "" };
            setV(empty);
            apply(empty);
          }}
        >
          Clear
        </Button>
      </div>
      {rangeBad ? (
        <p role="alert" className="col-span-2 text-sm text-destructive sm:col-span-5">
          &apos;From&apos; must be on or before &apos;to&apos;.
        </p>
      ) : null}
    </form>
  );
}
