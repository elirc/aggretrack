import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";

import { formatCell, formatReport } from "../../src/components/reports/format";
import { parseReportParams } from "../../src/components/reports/definitions";
import { buildReportWorkbook, HEADER_ROW, NUM_FMT } from "../../src/lib/export/excel";
import { renderReportPdf } from "../../src/lib/export/renderReportPdf";
import type { AnyReportResult } from "../../src/lib/services/reports";

// Synthetic report covering every column type.
const report: AnyReportResult = {
  key: "purchases",
  title: "Purchases by supplier",
  subtitle: "2026-09-01 → 2026-09-30",
  columns: [
    { key: "name", label: "Supplier", type: "text" },
    { key: "day", label: "Date", type: "date" },
    { key: "at", label: "When", type: "datetime" },
    { key: "netKg", label: "Net kg", type: "kg" },
    { key: "amountKobo", label: "Amount", type: "kobo" },
    { key: "rate", label: "Avg price / kg", type: "rate" },
    { key: "pct", label: "Deduction %", type: "percent" },
    { key: "bags", label: "Bags", type: "int" },
  ],
  rows: [
    {
      name: "Musa Ibrahim",
      day: "2026-09-03",
      at: new Date("2026-09-03T23:30:00.000Z"), // 04 Sep 00:30 in Lagos
      netKg: "1234.500",
      amountKobo: 55_552_500,
      rate: 45_000,
      pct: 1.55,
      bags: 25,
    },
    {
      name: "Aisha Bello",
      day: "2026-09-10",
      at: "2026-09-10T09:00:00.000Z",
      netKg: "500.000",
      amountKobo: 22_500_000,
      rate: "45000.0000",
      pct: 0,
      bags: 10,
    },
  ],
  totals: { name: "Total", netKg: "1734.500", amountKobo: 78_052_500, rate: 45_000, bags: 35 },
};

async function readBack(buf: Buffer) {
  const wb = new ExcelJS.Workbook();
  // ExcelJS's Buffer typing predates Node's generic Buffer; the runtime accepts it.
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  return wb.worksheets[0];
}

describe("buildReportWorkbook", () => {
  it("writes title, bold frozen header, typed cells and a bold totals row", async () => {
    const buf = await buildReportWorkbook(report, { orgName: "Kano Grains Ltd" });
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.subarray(0, 2).toString()).toBe("PK"); // zip container

    const ws = await readBack(buf);
    expect(ws.name).toBe("Purchases by supplier");
    expect(ws.getCell(1, 1).value).toBe("Purchases by supplier");
    expect(String(ws.getCell(2, 1).value)).toContain("Kano Grains Ltd");

    // Header
    const header = ws.getRow(HEADER_ROW);
    const labels = report.columns.map((_, i) => header.getCell(i + 1).value);
    expect(labels).toEqual(report.columns.map((c) => c.label));
    expect(header.getCell(1).font?.bold).toBe(true);
    expect(ws.views[0]).toMatchObject({ state: "frozen", ySplit: HEADER_ROW });

    // First data row
    const r1 = ws.getRow(HEADER_ROW + 1);
    expect(r1.getCell(1).value).toBe("Musa Ibrahim");
    const d = r1.getCell(2).value as Date;
    expect(d.toISOString().slice(0, 10)).toBe("2026-09-03");
    expect(r1.getCell(2).numFmt).toBe(NUM_FMT.date);
    const dt = r1.getCell(3).value as Date;
    expect(dt.toISOString().slice(0, 16)).toBe("2026-09-04T00:30"); // Lagos wall time
    expect(r1.getCell(4).value).toBe(1234.5);
    expect(r1.getCell(4).numFmt).toBe("#,##0.000");
    expect(r1.getCell(5).value).toBe(555_525); // ₦555,525.00 (kobo / 100)
    expect(r1.getCell(5).numFmt).toBe(NUM_FMT.kobo);
    expect(NUM_FMT.kobo).toContain("₦");
    expect(r1.getCell(6).value).toBe(450);
    expect(r1.getCell(7).value).toBeCloseTo(0.0155, 10);
    expect(r1.getCell(7).numFmt).toBe("0.00%");
    expect(r1.getCell(8).value).toBe(25);

    // Numeric string rate parses
    expect(ws.getRow(HEADER_ROW + 2).getCell(6).value).toBe(450);

    // Totals
    const t = ws.getRow(HEADER_ROW + 3);
    expect(t.getCell(1).value).toBe("Total");
    expect(t.getCell(1).font?.bold).toBe(true);
    expect(t.getCell(5).value).toBe(780_525);
    expect(t.getCell(5).font?.bold).toBe(true);
    expect(t.getCell(4).value).toBe(1734.5);
    expect(t.getCell(7).value).toBeNull(); // no percent total
  });

  it("handles an empty report with no totals", async () => {
    const ws = await readBack(await buildReportWorkbook({ ...report, rows: [], totals: null }));
    expect(ws.getRow(HEADER_ROW).getCell(1).value).toBe("Supplier");
    expect(ws.getRow(HEADER_ROW + 1).getCell(1).value).toBeNull();
  });
});

describe("report cell formatting", () => {
  it("formats every column type for screen and PDF", () => {
    expect(formatCell("kg", "1234.5")).toBe("1,234.500 kg");
    expect(formatCell("kobo", 55_552_500)).toBe("₦555,525.00");
    expect(formatCell("kobo", -150)).toBe("-₦1.50");
    expect(formatCell("kobo", 55_552_500, "pdf")).toBe("NGN 555,525.00");
    expect(formatCell("rate", "45000.0000")).toBe("₦450.00/kg");
    expect(formatCell("percent", 1.555)).toMatch(/^1\.5[56]%$/);
    expect(formatCell("int", 12345)).toBe("12,345");
    expect(formatCell("date", "2026-09-03")).toBe("03 Sep 2026");
    expect(formatCell("datetime", new Date("2026-09-03T23:30:00.000Z"))).toBe("04 Sep 2026, 00:30");
    expect(formatCell("text", null)).toBe("—");
  });

  it("formatReport labels the totals row", () => {
    const f = formatReport({ ...report, totals: { amountKobo: 100 } });
    expect(f.totals?.name).toBe("Total");
    expect(f.totals?.amountKobo).toBe("₦1.00");
    expect(f.columns.find((c) => c.key === "netKg")?.numeric).toBe(true);
  });
});

describe("report params", () => {
  it("fills Lagos month-to-date defaults and validates", () => {
    const now = new Date("2026-10-07T23:30:00.000Z"); // 08 Oct in Lagos
    const p = parseReportParams("purchases", {}, now);
    expect(p.ok).toBe(true);
    expect(p.raw).toMatchObject({ from: "2026-10-01", to: "2026-10-08", groupBy: "supplier" });
    const bad = parseReportParams("purchases", { from: "2026-10-09", to: "2026-10-01" }, now);
    expect(bad.ok).toBe(false);
    const asAt = parseReportParams("payables-ageing", { supplierId: "" }, now);
    expect(asAt.ok && asAt.input.report === "payables-ageing" && asAt.input.params.asAt).toBe("2026-10-08");
  });
});

describe("renderReportPdf", () => {
  it("renders a landscape report PDF", async () => {
    const buf = await renderReportPdf({
      org: { name: "Kano Grains Ltd" },
      report,
      generatedAt: "2026-10-08T09:30:00.000Z",
    });
    expect(buf.length).toBeGreaterThan(1000);
    expect(buf.subarray(0, 4).toString()).toBe("%PDF");
  }, 30_000);
});
