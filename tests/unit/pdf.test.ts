import { describe, expect, it } from "vitest";

// Import-light: render.ts pulls only react-pdf + templates + domain/units (no DB, no adapters).
import { amountInWords, pdfDate, pdfDateTime, pdfKg, pdfNaira } from "../../src/pdf/format";
import { renderPdf, type PdfKind, type PdfPropsMap } from "../../src/pdf/render";

const org = { name: "Kano Grains Ltd", address: "12 Bompai Rd, Kano", phone: "08012345678" };
const generatedAt = "2026-10-08T09:30:00.000Z";

const fixtures: { [K in PdfKind]: PdfPropsMap[K] } = {
  grn: {
    org,
    grnNumber: "GRN-2026-00001",
    purchaseNumber: "PO-2026-00001",
    purchaseDate: "2026-10-07",
    receivedAt: "2026-10-08T08:00:00.000Z",
    receivedWarehouse: "Kano Main",
    buyingPoint: "Dawanau",
    officer: "Aisha Bello",
    supplier: { name: "Musa Ibrahim", phone: "08098765432", addressLines: ["Dawakin Tofa", "Kano"] },
    lines: [
      {
        commodity: "Maize",
        grade: "A",
        bags: 10,
        grossGrams: 1_005_000,
        deductionGrams: 15_500,
        netGrams: 989_500,
        pricePerKgKobo: 45_000,
        amountKobo: 44_527_500,
        lotNumber: "LOT-2026-00001",
      },
    ],
    totalAmountKobo: 44_527_500,
    generatedAt,
  },
  waybill: {
    org,
    waybillNumber: "WB-2026-00001",
    dispatchedAt: "2026-10-08T10:00:00.000Z",
    salesOrderNumber: "SO-2026-00001",
    customer: { name: "Lagos Feeds Plc", addressLines: ["Ikeja", "Lagos"] },
    fromWarehouse: "Kano Main",
    vehicle: { plateNumber: "KAN-123-XY", description: "30t trailer" },
    driver: { name: "Sani Garba", phone: "08011112222" },
    lines: [{ lotNumber: "LOT-2026-00001", commodity: "Maize", grade: "A", grams: 500_000, bags: null }],
    dispatchedGrams: 500_000,
    deliveredGrams: null,
    generatedAt,
  },
  invoice: {
    org,
    invoiceNumber: "INV-2026-00001",
    invoiceDate: "2026-10-08",
    dueDate: "2026-11-07",
    salesOrderNumber: "SO-2026-00001",
    waybillNumber: "WB-2026-00001",
    customer: { name: "Lagos Feeds Plc", phone: "07000000000", addressLines: ["Ikeja", "Lagos"] },
    lines: [{ description: "Maize", grade: "A", grams: 500_000, pricePerKgKobo: 60_000, amountKobo: 30_000_000 }],
    subtotalKobo: 30_000_000,
    taxPercent: "7.50",
    taxKobo: 2_250_000,
    totalKobo: 32_250_000,
    paidKobo: 10_000_000,
    status: "part_paid",
    bankDetails: null,
    generatedAt,
  },
  supplier_statement: {
    org,
    supplier: { name: "Musa Ibrahim", phone: "08098765432" },
    periodFrom: "2026-10-01",
    periodTo: "2026-10-08",
    rows: [
      { date: "2026-10-07", kind: "purchase", reference: "PO-2026-00001", amountKobo: 44_527_500 },
      { date: "2026-10-02", kind: "advance", reference: "ADV-2026-00001", amountKobo: -5_000_000 },
      { date: "2026-10-08", kind: "payment", reference: "SPM-2026-00001", amountKobo: -20_000_000 },
      { date: "2026-10-07", kind: "offset", reference: "ADV-2026-00001", description: "Advance recovered", amountKobo: 0 },
    ],
    generatedAt,
  },
  customer_statement: {
    org,
    customer: { name: "Lagos Feeds Plc" },
    openingBalanceKobo: 0,
    rows: [
      { date: "2026-10-08", kind: "invoice", reference: "INV-2026-00001", amountKobo: 32_250_000 },
      { date: "2026-10-08T15:00:00.000Z", kind: "payment", reference: "CPM-2026-00001", amountKobo: -10_000_000 },
    ],
    generatedAt,
  },
};

describe("pdf templates", () => {
  for (const kind of Object.keys(fixtures) as PdfKind[]) {
    it(`renders ${kind} to a non-empty PDF buffer`, async () => {
      const buf = await renderPdf(kind, fixtures[kind] as never);
      expect(Buffer.isBuffer(buf)).toBe(true);
      expect(buf.length).toBeGreaterThan(500);
      expect(buf.subarray(0, 4).toString("latin1")).toBe("%PDF");
    }, 30_000);
  }

  it("renders empty-line documents without throwing", async () => {
    const buf = await renderPdf("grn", { ...fixtures.grn, lines: [], totalAmountKobo: 0, hidePrices: true });
    expect(buf.subarray(0, 4).toString("latin1")).toBe("%PDF");
  }, 30_000);
});

describe("pdf format helpers", () => {
  it("formats naira without the (Helvetica-missing) naira glyph", () => {
    expect(pdfNaira(1_234_567)).toBe("NGN 12,345.67");
    expect(pdfNaira(-50)).toBe("-NGN 0.50");
  });

  it("formats kg with 3 decimals", () => {
    expect(pdfKg(1_234_500)).toBe("1,234.500");
    expect(pdfKg(5)).toBe("0.005");
  });

  it("formats dates in Africa/Lagos and keeps calendar dates unshifted", () => {
    expect(pdfDate("2026-10-08")).toBe("08 Oct 2026");
    // 23:30 UTC on the 7th is 00:30 WAT on the 8th.
    expect(pdfDate("2026-10-07T23:30:00.000Z")).toBe("08 Oct 2026");
    expect(pdfDateTime("2026-10-07T23:30:00.000Z")).toBe("08 Oct 2026, 00:30");
  });

  it("spells amounts in words", () => {
    expect(amountInWords(1_234_550)).toBe(
      "Twelve thousand, three hundred and forty-five naira, fifty kobo only",
    );
    expect(amountInWords(100_000_500)).toBe("One million and five naira only");
    expect(amountInWords(0)).toBe("Zero naira only");
  });
});
