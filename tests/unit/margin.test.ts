import { describe, expect, it } from "vitest";
import { computeMargin, dispatchedCostKobo } from "@/lib/domain/margin";
import { formatDocDate, formatKg, formatLagosDate, formatLagosDateTime, formatNairaFromKobo } from "@/lib/domain/format";

describe("dispatchedCostKobo", () => {
  it("grams × rate / 1000 with integer rate", () => {
    expect(dispatchedCostKobo(96_200, 30_556)).toBe(2_939_487); // 2,939,487.2
  });

  it("4-dp landed rate rounds half-up exactly", () => {
    expect(dispatchedCostKobo(1_000, 30_556.5)).toBe(30_557); // 30,556.5
    expect(dispatchedCostKobo(1_500, 12_345.6789)).toBe(18_519); // 18,518.51835
    expect(dispatchedCostKobo(1, 500)).toBe(1); // 0.5
    expect(dispatchedCostKobo(1, 499.9999)).toBe(0); // 0.4999999
  });

  it("zero grams or zero rate → 0", () => {
    expect(dispatchedCostKobo(0, 30_556.1234)).toBe(0);
    expect(dispatchedCostKobo(96_200, 0)).toBe(0);
  });
});

describe("computeMargin", () => {
  it("margin = revenue − cost − expenses, with percent", () => {
    expect(computeMargin(100_000, 60_000, 15_000)).toEqual({ marginKobo: 25_000, marginPercent: 25 });
  });

  it("negative margin", () => {
    expect(computeMargin(200_000, 210_000, 0)).toEqual({ marginKobo: -10_000, marginPercent: -5 });
  });

  it("zero revenue → percent 0", () => {
    expect(computeMargin(0, 5_000, 1_000)).toEqual({ marginKobo: -6_000, marginPercent: 0 });
    expect(computeMargin(0, 0, 0)).toEqual({ marginKobo: 0, marginPercent: 0 });
  });
});

describe("format", () => {
  it("formatKg", () => {
    expect(formatKg(1_234_500)).toBe("1,234.500 kg");
    expect(formatKg(0)).toBe("0.000 kg");
    expect(formatKg(96_200)).toBe("96.200 kg");
    expect(formatKg(1_234_567_891)).toBe("1,234,567.891 kg");
    expect(formatKg(-2_500)).toBe("-2.500 kg");
  });

  it("formatNairaFromKobo", () => {
    expect(formatNairaFromKobo(1_234_567)).toBe("₦12,345.67");
    expect(formatNairaFromKobo(5)).toBe("₦0.05");
  });

  it("Lagos dates (UTC+1) cross midnight correctly", () => {
    const d = new Date("2026-10-07T23:30:00Z"); // 00:30 on 8 Oct in Lagos
    expect(formatDocDate(d)).toBe("2026-10-08");
    expect(formatLagosDate(d)).toBe("08 Oct 2026");
    expect(formatLagosDateTime(d)).toBe("08 Oct 2026, 00:30");
    expect(formatLagosDateTime(new Date("2026-01-05T13:05:00Z"))).toBe("05 Jan 2026, 14:05");
    expect(formatDocDate(new Date("2026-01-05T13:05:00Z"))).toBe("2026-01-05");
  });
});
