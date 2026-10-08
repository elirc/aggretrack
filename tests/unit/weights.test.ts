import { describe, expect, it } from "vitest";
import { computeLineAmountKobo, computeNetGrams, computeSackDeductionGrams } from "@/lib/domain/weights";
import { DomainError } from "@/lib/domain/errors";
import { sumMovements, availableGrams } from "@/lib/domain/stock";

describe("computeNetGrams", () => {
  it("net = gross − Σ deductions", () => {
    expect(
      computeNetGrams(100_000, [
        { reason: "moisture", grams: 2_500 },
        { reason: "sack_weight", grams: 1_300 },
        { reason: "foreign_matter", grams: 200 },
      ]),
    ).toBe(96_000);
  });

  it("zero deductions → net = gross", () => {
    expect(computeNetGrams(96_200, [])).toBe(96_200);
  });

  it("deductions exactly equal to gross → net 0 (legal)", () => {
    expect(computeNetGrams(5_000, [{ reason: "other", grams: 5_000 }])).toBe(0);
  });

  it("negative net throws NET_WEIGHT_NEGATIVE", () => {
    let caught: unknown;
    try {
      computeNetGrams(1_000, [{ reason: "moisture", grams: 1_001 }]);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(DomainError);
    expect((caught as DomainError).code).toBe("NET_WEIGHT_NEGATIVE");
  });

  it("negative deduction is rejected", () => {
    expect(() => computeNetGrams(1_000, [{ reason: "other", grams: -1 }])).toThrow(DomainError);
  });
});

describe("computeLineAmountKobo", () => {
  it("96.2 kg × 30556 kobo/kg rounds down below .5 (2,939,487.2 → 2,939,487)", () => {
    expect(computeLineAmountKobo(96_200, 30_556)).toBe(2_939_487);
  });

  it("exact product needs no rounding (96.2 kg × 30555 → 2,939,391)", () => {
    expect(computeLineAmountKobo(96_200, 30_555)).toBe(2_939_391);
  });

  it("exactly .5 rounds half-up (96.1 kg × 30555 = 2,936,335.5 → 2,936,336)", () => {
    expect(computeLineAmountKobo(96_100, 30_555)).toBe(2_936_336);
  });

  it("small half cases round up", () => {
    expect(computeLineAmountKobo(500, 1)).toBe(1); // 0.5
    expect(computeLineAmountKobo(1_500, 3)).toBe(5); // 4.5
    expect(computeLineAmountKobo(499, 1)).toBe(0); // 0.499
  });

  it("zero weight or zero price → 0", () => {
    expect(computeLineAmountKobo(0, 30_556)).toBe(0);
    expect(computeLineAmountKobo(96_200, 0)).toBe(0);
  });

  it("stays exact for products beyond 2^53", () => {
    // 999,999,999.999 kg × 9,999 kobo/kg = 9,998,999,999,990.001 kobo (product > 2^53)
    expect(computeLineAmountKobo(999_999_999_999, 9_999)).toBe(9_998_999_999_990);
  });

  it("purchase total = Σ line amounts with no re-rounding", () => {
    const lines = [computeLineAmountKobo(500, 1), computeLineAmountKobo(500, 1)];
    expect(lines.reduce((a, b) => a + b, 0)).toBe(2); // not round(1000 g × 1) = 1
  });
});

describe("computeSackDeductionGrams", () => {
  it("bags × sack weight kg", () => {
    expect(computeSackDeductionGrams(10, "0.130")).toBe(1_300);
    expect(computeSackDeductionGrams(0, "0.500")).toBe(0);
  });
  it("rejects fractional bag counts", () => {
    expect(() => computeSackDeductionGrams(1.5, "0.1")).toThrow(DomainError);
  });
});

describe("stock helpers", () => {
  it("sumMovements sums signed grams", () => {
    expect(sumMovements([{ kg: 10_000 }, { kg: -2_500 }, { kg: 300 }, { kg: -7_800 }])).toBe(0);
    expect(sumMovements([])).toBe(0);
  });

  it("availableGrams = on hand − reserved", () => {
    expect(availableGrams(10_000, 4_000)).toBe(6_000);
    expect(availableGrams(4_000, 4_000)).toBe(0);
  });

  it("availableGrams throws STOCK_INVARIANT_BREACH when negative", () => {
    try {
      availableGrams(1_000, 1_001);
      expect.unreachable();
    } catch (e) {
      expect((e as DomainError).code).toBe("STOCK_INVARIANT_BREACH");
    }
  });
});
