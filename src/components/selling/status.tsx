import { Badge } from "@/components/ui/badge";

type Tone = "neutral" | "info" | "warn" | "good" | "bad";

const TONE_CLASS: Record<Tone, string> = {
  neutral: "border-border bg-muted text-muted-foreground",
  info: "border-sky-200 bg-sky-50 text-sky-800 dark:border-sky-900 dark:bg-sky-950 dark:text-sky-200",
  warn: "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100",
  good: "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-200",
  bad: "border-red-200 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200",
};

function Chip({ tone, label }: { tone: Tone; label: string }) {
  return (
    <Badge variant="outline" className={TONE_CLASS[tone]}>
      {label}
    </Badge>
  );
}

export const SALES_STATUS: Record<string, { label: string; tone: Tone }> = {
  draft: { label: "Draft", tone: "neutral" },
  confirmed: { label: "Confirmed", tone: "info" },
  allocated: { label: "Allocated", tone: "warn" },
  dispatched: { label: "Dispatched", tone: "good" },
  completed: { label: "Completed", tone: "good" },
  cancelled: { label: "Cancelled", tone: "bad" },
};

export const INVOICE_STATUS: Record<string, { label: string; tone: Tone }> = {
  issued: { label: "Issued", tone: "info" },
  part_paid: { label: "Part paid", tone: "warn" },
  paid: { label: "Paid", tone: "good" },
  void: { label: "Void", tone: "bad" },
};

export const DISPATCH_STATUS: Record<string, { label: string; tone: Tone }> = {
  in_transit: { label: "In transit", tone: "warn" },
  delivered: { label: "Delivered", tone: "good" },
};

export const ALLOCATION_STATUS: Record<string, { label: string; tone: Tone }> = {
  reserved: { label: "Reserved", tone: "warn" },
  dispatched: { label: "Dispatched", tone: "good" },
  cancelled: { label: "Released", tone: "neutral" },
};

function make(map: Record<string, { label: string; tone: Tone }>) {
  return function StatusBadge({ status }: { status: string }) {
    const s = map[status] ?? { label: status, tone: "neutral" as Tone };
    return <Chip tone={s.tone} label={s.label} />;
  };
}

export const SalesStatusBadge = make(SALES_STATUS);
export const InvoiceStatusBadge = make(INVOICE_STATUS);
export const DispatchStatusBadge = make(DISPATCH_STATUS);
export const AllocationStatusBadge = make(ALLOCATION_STATUS);
