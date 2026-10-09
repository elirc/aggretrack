"use client";

import { FileText, Loader2 } from "lucide-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { actionErrorMessage } from "@/components/logistics/run-action";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { ActionResult } from "@/lib/authz/guard";

/**
 * Shared "Statement" button (P4-D): a small popover with a from/to period
 * (default: last 90 days, Africa/Lagos calendar), then generates the PDF via
 * the given server action and opens /api/documents/{id} in a new tab.
 * Used by the supplier and customer statement-button files.
 */

type StatementAction = (input: {
  id: string;
  from: string;
  to: string;
}) => Promise<ActionResult<{ documentId: string; closingBalanceKobo: number }>>;

function lagosDate(at: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Lagos",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

function defaultRange(): { from: string; to: string } {
  const now = new Date();
  return { from: lagosDate(new Date(now.getTime() - 90 * 86_400_000)), to: lagosDate(now) };
}

export function StatementRangeButton({
  id,
  action,
  label = "Statement",
}: {
  id: string;
  action: StatementAction;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const [range, setRange] = useState(defaultRange);
  const [pending, startTransition] = useTransition();
  const invalid = !range.from || !range.to || range.from > range.to;

  const generate = () => {
    // Open the tab synchronously (inside the click) so popup blockers allow it; point it at the PDF once ready.
    const tab = typeof window !== "undefined" ? window.open("about:blank", "_blank") : null;
    startTransition(async () => {
      let res: Awaited<ReturnType<StatementAction>>;
      try {
        res = await action({ id, from: range.from, to: range.to });
      } catch {
        res = { ok: false, error: "NETWORK" };
      }
      if (!res.ok) {
        tab?.close();
        toast.error(
          res.error === "NETWORK"
            ? "Could not reach the server. Check your connection and try again."
            : actionErrorMessage(res.error),
        );
        return;
      }
      const href = `/api/documents/${res.data.documentId}`;
      if (tab) tab.location.href = href;
      else window.open(href, "_blank");
      toast.success("Statement ready", {
        action: { label: "Open", onClick: () => window.open(href, "_blank") },
      });
      setOpen(false);
    });
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" className="h-11 sm:h-9">
          <FileText /> {label}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72">
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!invalid && !pending) generate();
          }}
        >
          <p className="text-sm font-medium">Statement period</p>
          <div className="grid grid-cols-2 gap-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`stmt-from-${id}`}>From</Label>
              <Input
                id={`stmt-from-${id}`}
                type="date"
                value={range.from}
                max={range.to || undefined}
                onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))}
                className="h-11 sm:h-9"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`stmt-to-${id}`}>To</Label>
              <Input
                id={`stmt-to-${id}`}
                type="date"
                value={range.to}
                min={range.from || undefined}
                onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))}
                className="h-11 sm:h-9"
              />
            </div>
          </div>
          {invalid ? <p className="text-xs text-destructive">Pick a start date on or before the end date.</p> : null}
          <Button type="submit" className="h-11 sm:h-9" disabled={invalid || pending}>
            {pending ? <Loader2 className="animate-spin" /> : <FileText />}
            {pending ? "Preparing…" : "Generate PDF"}
          </Button>
        </form>
      </PopoverContent>
    </Popover>
  );
}
