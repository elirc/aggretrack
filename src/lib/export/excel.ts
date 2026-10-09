/**
 * ReportResult → .xlsx (ExcelJS). Node only.
 *
 * Layout: row 1 title, row 2 org + period, row 3 blank, row 4 the bold header
 * (frozen), data rows, then a bold totals row. Cells hold real numbers with
 * number formats so an accountant can sum/pivot: kg as kg, kobo as naira
 * (kobo / 100), percent as a fraction, dates as Excel dates (Lagos wall time).
 */
import ExcelJS from "exceljs";

import type { AnyReportResult, ColumnType } from "@/lib/services/reports";

export const HEADER_ROW = 4;

export const NUM_FMT: Record<ColumnType, string | undefined> = {
  text: undefined,
  date: "dd mmm yyyy",
  datetime: "dd mmm yyyy hh:mm",
  kg: "#,##0.000",
  kobo: '"₦"#,##0.00',
  rate: '"₦"#,##0.00',
  percent: "0.00%",
  int: "#,##0",
};

const WIDTH: Record<ColumnType, number> = {
  text: 26,
  date: 13,
  datetime: 18,
  kg: 15,
  kobo: 18,
  rate: 14,
  percent: 11,
  int: 10,
};

const LAGOS_OFFSET_MS = 60 * 60 * 1000; // WAT = UTC+1, no DST

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Excel cell value for a report value of the given column type. */
export function excelValue(type: ColumnType, v: unknown): ExcelJS.CellValue {
  if (v === null || v === undefined || v === "") return null;
  switch (type) {
    case "text":
      return String(v);
    case "date": {
      const s = v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
      return m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) : String(v);
    }
    case "datetime": {
      const d = v instanceof Date ? v : new Date(String(v));
      if (Number.isNaN(d.getTime())) return String(v);
      // ExcelJS serialises Dates as UTC; shift so the sheet shows Lagos wall time.
      return new Date(d.getTime() + LAGOS_OFFSET_MS);
    }
    case "kobo":
    case "rate": {
      const n = num(v);
      return n === null ? String(v) : n / 100;
    }
    case "percent": {
      const n = num(v);
      return n === null ? String(v) : n / 100;
    }
    case "kg":
    case "int": {
      const n = num(v);
      return n === null ? String(v) : n;
    }
  }
}

function sheetName(title: string): string {
  const cleaned = title.replace(/[[\]:*?/\\]/g, " ").trim();
  return (cleaned || "Report").slice(0, 31);
}

export async function buildReportWorkbook(
  report: AnyReportResult,
  opts: { orgName?: string; generatedAt?: Date } = {},
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "AggreTrack";
  wb.created = opts.generatedAt ?? new Date();
  wb.title = report.title;
  if (opts.orgName) wb.company = opts.orgName;

  const cols = report.columns;
  const ws = wb.addWorksheet(sheetName(report.title), {
    views: [{ state: "frozen", ySplit: HEADER_ROW }],
  });

  ws.columns = cols.map((c) => ({
    key: c.key,
    width: Math.max(WIDTH[c.type], c.label.length + 2),
  }));

  const titleCell = ws.getCell(1, 1);
  titleCell.value = report.title;
  titleCell.font = { bold: true, size: 14 };
  ws.getCell(2, 1).value = [opts.orgName, report.subtitle].filter(Boolean).join(" · ");
  ws.getCell(2, 1).font = { italic: true, color: { argb: "FF666666" } };

  const header = ws.getRow(HEADER_ROW);
  cols.forEach((c, i) => {
    const cell = header.getCell(i + 1);
    cell.value = c.label;
    cell.font = { bold: true };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEFEFEF" } };
    cell.border = { bottom: { style: "thin" } };
    cell.alignment = { vertical: "middle", horizontal: c.type === "text" ? "left" : "right", wrapText: true };
  });
  header.commit();

  const writeRow = (rowNum: number, data: Record<string, unknown>, bold: boolean) => {
    const row = ws.getRow(rowNum);
    cols.forEach((c, i) => {
      const cell = row.getCell(i + 1);
      cell.value = excelValue(c.type, data[c.key]);
      const fmt = NUM_FMT[c.type];
      if (fmt) cell.numFmt = fmt;
      if (bold) {
        cell.font = { bold: true };
        cell.border = { top: { style: "thin" } };
      }
    });
    row.commit();
  };

  let r = HEADER_ROW + 1;
  for (const row of report.rows as Record<string, unknown>[]) writeRow(r++, row, false);
  if (report.totals) {
    const totals = { ...(report.totals as Record<string, unknown>) };
    // Ensure a visible label even if the service put it on a non-first column.
    const firstKey = cols[0]?.key;
    if (firstKey && (totals[firstKey] === undefined || totals[firstKey] === null) && cols[0].type === "text") {
      totals[firstKey] = "Total";
    }
    writeRow(r++, totals, true);
  }

  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out as ArrayBuffer);
}
