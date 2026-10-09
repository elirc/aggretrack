/**
 * Cell formatting by ReportResult column type, shared by the on-screen table
 * and the PDF export. Pure: no React, no DB.
 *
 * Value conventions (src/lib/services/reports.ts): kg = numeric(12,3) string
 * (or number), kobo = integer kobo, rate = kobo/kg (number or numeric string),
 * percent = 0–100 number, date = "yyyy-mm-dd", datetime = Date | ISO string.
 */
import { pdfDate, pdfDateTime } from "@/pdf/format";
import type { ColumnType } from "@/lib/services/reports";

export type CellMode = "ui" | "pdf";

const NUMERIC: ReadonlySet<ColumnType> = new Set(["kg", "kobo", "rate", "percent", "int"]);

export function isNumericType(t: ColumnType): boolean {
  return NUMERIC.has(t);
}

function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function toNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Fixed-decimals with thousands separators, exact for numeric strings. */
function fixed(v: unknown, dp: number): string | null {
  const n = toNumber(v);
  if (n === null) return null;
  const s = n.toFixed(dp);
  const neg = s.startsWith("-");
  const [whole, frac] = (neg ? s.slice(1) : s).split(".");
  const out = `${groupThousands(whole)}${frac !== undefined ? `.${frac}` : ""}`;
  return neg && Number(s) !== 0 ? `-${out}` : out;
}

function money(naira: string, mode: CellMode): string {
  const sym = mode === "pdf" ? "NGN " : "₦";
  return naira.startsWith("-") ? `-${sym}${naira.slice(1)}` : `${sym}${naira}`;
}

/** Display string for one cell; "—" ("-" in PDF) for empty values. */
export function formatCell(type: ColumnType, value: unknown, mode: CellMode = "ui"): string {
  const empty = mode === "pdf" ? "-" : "—";
  if (value === null || value === undefined || value === "") return empty;
  switch (type) {
    case "text":
      return String(value);
    case "date":
      return pdfDate(value instanceof Date ? value : String(value));
    case "datetime":
      return pdfDateTime(value instanceof Date ? value : String(value));
    case "kg": {
      const s = fixed(value, 3);
      return s === null ? String(value) : `${s}${mode === "ui" ? " kg" : ""}`;
    }
    case "kobo": {
      const n = toNumber(value);
      if (n === null) return String(value);
      return money(fixed(n / 100, 2)!, mode);
    }
    case "rate": {
      const n = toNumber(value);
      if (n === null) return String(value);
      return `${money(fixed(n / 100, 2)!, mode)}/kg`;
    }
    case "percent": {
      const s = fixed(value, 2);
      return s === null ? String(value) : `${s}%`;
    }
    case "int": {
      const s = fixed(value, 0);
      return s === null ? String(value) : s;
    }
  }
}

/** Display shape for the on-screen table (all cells pre-formatted on the server). */
export type FormattedReportShape = {
  columns: { key: string; label: string; numeric: boolean }[];
  rows: Record<string, string>[];
  totals: Record<string, string> | null;
};

export function formatReport(report: {
  columns: { key: string; label: string; type: ColumnType }[];
  rows: unknown[];
  totals: unknown;
}): FormattedReportShape {
  const fmtRow = (row: Record<string, unknown>, isTotals: boolean) => {
    const out: Record<string, string> = {};
    report.columns.forEach((c, i) => {
      const v = row[c.key];
      if (isTotals && (v === undefined || v === null || v === "")) out[c.key] = i === 0 ? "Total" : "";
      else out[c.key] = formatCell(c.type, v, "ui");
    });
    return out;
  };
  return {
    columns: report.columns.map((c) => ({ key: c.key, label: c.label, numeric: isNumericType(c.type) })),
    rows: (report.rows as Record<string, unknown>[]).map((r) => fmtRow(r, false)),
    totals: report.totals ? fmtRow(report.totals as Record<string, unknown>, true) : null,
  };
}
