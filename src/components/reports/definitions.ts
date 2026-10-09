/**
 * Report catalogue + URL-param contract shared by the reports pages and the
 * export route. Pure (no DB, no server-only) so client filter forms can use
 * the same field specs.
 *
 * URL params use the report schema's own keys (from, to, asAt, supplierId,
 * groupBy …) so a report link and its export link carry identical params and
 * are parsed by the same runReportInput schema.
 */
import { formatDocDate } from "@/lib/domain/format";
import { REPORT_KEYS, runReportInput, type ReportKey, type RunReportInput } from "@/lib/validation/logistics";

export type EntityKind = "supplier" | "customer" | "commodity" | "warehouse" | "buyingPoint" | "vehicle" | "grade";

export type ReportField =
  | { kind: "date"; param: "from" | "to" | "asAt"; label: string }
  | { kind: "entity"; param: string; label: string; entity: EntityKind; allLabel: string }
  | {
      kind: "enum";
      param: string;
      label: string;
      options: { value: string; label: string }[];
      /** When absent the select offers an "All" choice. */
      defaultValue?: string;
      allLabel?: string;
    }
  /** Carried through the URL (e.g. deep links) but no control is rendered. */
  | { kind: "hidden"; param: string };

export type ReportDef = {
  key: ReportKey;
  title: string;
  description: string;
  fields: ReportField[];
};

const FROM: ReportField = { kind: "date", param: "from", label: "From" };
const TO: ReportField = { kind: "date", param: "to", label: "To" };
const AS_AT: ReportField = { kind: "date", param: "asAt", label: "As at" };
const ent = (param: string, entity: EntityKind, label: string, allLabel: string): ReportField => ({
  kind: "entity",
  param,
  entity,
  label,
  allLabel,
});
const SUPPLIER = ent("supplierId", "supplier", "Supplier", "All suppliers");
const CUSTOMER = ent("customerId", "customer", "Customer", "All customers");
const COMMODITY = ent("commodityId", "commodity", "Commodity", "All commodities");
const WAREHOUSE = ent("warehouseId", "warehouse", "Warehouse", "All warehouses");

export const REPORT_DEFS: Record<ReportKey, ReportDef> = {
  purchases: {
    key: "purchases",
    title: "Purchases",
    description: "Weight and spend by supplier, commodity or period.",
    fields: [
      FROM,
      TO,
      {
        kind: "enum",
        param: "groupBy",
        label: "Group by",
        defaultValue: "supplier",
        options: [
          { value: "supplier", label: "Supplier" },
          { value: "commodity", label: "Commodity" },
          { value: "day", label: "Day" },
          { value: "week", label: "Week" },
          { value: "month", label: "Month" },
        ],
      },
      SUPPLIER,
      COMMODITY,
      ent("buyingPointId", "buyingPoint", "Buying point", "All buying points"),
    ],
  },
  "stock-position": {
    key: "stock-position",
    title: "Stock position",
    description: "Stock on hand per lot as at any date.",
    fields: [AS_AT, WAREHOUSE, COMMODITY, ent("gradeId", "grade", "Grade", "All grades")],
  },
  "stock-movements": {
    key: "stock-movements",
    title: "Stock movements",
    description: "Every receipt, transfer, adjustment and dispatch.",
    fields: [
      FROM,
      TO,
      WAREHOUSE,
      COMMODITY,
      {
        kind: "enum",
        param: "type",
        label: "Movement type",
        allLabel: "All types",
        options: [
          { value: "receive", label: "Receive" },
          { value: "transfer_out", label: "Transfer out" },
          { value: "transfer_in", label: "Transfer in" },
          { value: "adjustment", label: "Adjustment" },
          { value: "dispatch", label: "Dispatch" },
          { value: "return", label: "Return" },
        ],
      },
      { kind: "hidden", param: "lotId" },
      { kind: "hidden", param: "limit" },
    ],
  },
  "sales-by-customer": {
    key: "sales-by-customer",
    title: "Sales by customer",
    description: "Quantities sold and revenue per customer.",
    fields: [FROM, TO, CUSTOMER, COMMODITY],
  },
  margin: {
    key: "margin",
    title: "Margin",
    description: "Revenue less landed cost and attached expenses.",
    fields: [
      FROM,
      TO,
      {
        kind: "enum",
        param: "by",
        label: "Margin by",
        defaultValue: "sale",
        options: [
          { value: "sale", label: "Sale" },
          { value: "lot", label: "Lot" },
          { value: "customer", label: "Customer" },
          { value: "commodity", label: "Commodity" },
        ],
      },
      CUSTOMER,
      COMMODITY,
    ],
  },
  "payables-ageing": {
    key: "payables-ageing",
    title: "Payables ageing",
    description: "What you owe suppliers, by age band.",
    fields: [AS_AT, SUPPLIER],
  },
  "receivables-ageing": {
    key: "receivables-ageing",
    title: "Receivables ageing",
    description: "What customers owe you, by age band.",
    fields: [AS_AT, CUSTOMER],
  },
  "supplier-performance": {
    key: "supplier-performance",
    title: "Supplier performance",
    description: "Volume, deductions and price per supplier.",
    fields: [FROM, TO, SUPPLIER, COMMODITY],
  },
  shrinkage: {
    key: "shrinkage",
    title: "Shrinkage and losses",
    description: "Weight lost to drying, counts and adjustments.",
    fields: [FROM, TO, WAREHOUSE, COMMODITY],
  },
  "trip-costs": {
    key: "trip-costs",
    title: "Trip costs",
    description: "Transport and trip expenses per kg carried.",
    fields: [
      FROM,
      TO,
      {
        kind: "enum",
        param: "direction",
        label: "Direction",
        allLabel: "Both directions",
        options: [
          { value: "inbound", label: "Inbound" },
          { value: "outbound", label: "Outbound" },
        ],
      },
      ent("vehicleId", "vehicle", "Vehicle", "All vehicles"),
    ],
  },
};

export const REPORT_LIST: ReportDef[] = REPORT_KEYS.map((k) => REPORT_DEFS[k]);

export function isReportKey(s: string): s is ReportKey {
  return (REPORT_KEYS as readonly string[]).includes(s);
}

export type SP = Record<string, string | string[] | undefined>;

function first(sp: SP, key: string): string | undefined {
  const v = sp[key];
  const s = Array.isArray(v) ? v[0] : v;
  return s && s.trim() ? s.trim() : undefined;
}

/** Lagos-local defaults: this month to date, as at today. */
export function defaultDates(now: Date = new Date()): { from: string; to: string; asAt: string } {
  const today = formatDocDate(now);
  return { from: `${today.slice(0, 8)}01`, to: today, asAt: today };
}

/**
 * Raw (string) params for a report from URL search params: only the report's
 * own fields, with date defaults filled in. Feed to runReportInput.
 */
export function rawReportParams(key: ReportKey, sp: SP, now?: Date): Record<string, string> {
  const d = defaultDates(now);
  const out: Record<string, string> = {};
  for (const f of REPORT_DEFS[key].fields) {
    const v = first(sp, f.param);
    if (v !== undefined) out[f.param] = v;
    else if (f.kind === "date") out[f.param] = d[f.param];
    else if (f.kind === "enum" && f.defaultValue) out[f.param] = f.defaultValue;
  }
  return out;
}

export type ParsedReport =
  | { ok: true; input: RunReportInput; raw: Record<string, string> }
  | { ok: false; raw: Record<string, string>; fieldErrors: Record<string, string[]>; formErrors: string[] };

/** URL params → validated runReportInput (same schema the action/route use). */
export function parseReportParams(key: ReportKey, sp: SP, now?: Date): ParsedReport {
  const raw = rawReportParams(key, sp, now);
  const res = runReportInput.safeParse({ report: key, params: raw });
  if (res.success) return { ok: true, input: res.data, raw };
  const fieldErrors: Record<string, string[]> = {};
  const formErrors: string[] = [];
  for (const issue of res.error.issues) {
    // path: ["params", "<field>"] for field issues; ["params"] for refinements.
    const field = issue.path[1];
    if (typeof field === "string") (fieldErrors[field] ??= []).push(issue.message);
    else formErrors.push(issue.message);
  }
  return { ok: false, raw, fieldErrors, formErrors };
}

/** Query string for the current params (shareable report + export links). */
export function toQuery(raw: Record<string, string | undefined>, extra: Record<string, string> = {}): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...raw, ...extra })) if (v) sp.set(k, v);
  return sp.toString();
}
