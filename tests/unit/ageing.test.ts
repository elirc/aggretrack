import { describe, expect, it } from "vitest";
import { ageBand, ageInDays, bucketByAge } from "@/lib/domain/ageing";

const DAY = 86_400_000;
const origin = new Date("2026-01-01T10:00:00Z");
const plusDays = (n: number, hourUtc = 10) =>
  new Date(Date.UTC(2026, 0, 1 + n, hourUtc, 0, 0));

describe("ageInDays", () => {
  it("same day → 0, regardless of time of day", () => {
    expect(ageInDays(new Date("2026-01-01T23:59:59Z"), new Date("2026-01-01T00:00:00Z"))).toBe(0);
    expect(ageInDays(origin, origin)).toBe(0);
  });

  it("counts calendar days via UTC midnight, not elapsed 24h periods", () => {
    expect(ageInDays(new Date("2026-01-02T00:01:00Z"), new Date("2026-01-01T23:59:00Z"))).toBe(1);
    expect(ageInDays(new Date(origin.getTime() + 30 * DAY), origin)).toBe(30);
  });

  it("future origin clamps to 0", () => {
    expect(ageInDays(origin, plusDays(5))).toBe(0);
  });
});

describe("ageBand boundaries", () => {
  it.each([
    [0, "d0_30"],
    [30, "d0_30"],
    [31, "d31_60"],
    [60, "d31_60"],
    [61, "d61_90"],
    [90, "d61_90"],
    [91, "d90_plus"],
    [365, "d90_plus"],
  ] as const)("%i days → %s", (days, band) => {
    expect(ageBand(days)).toBe(band);
  });

  it("boundary days through ageInDays", () => {
    expect(ageBand(ageInDays(plusDays(30), origin))).toBe("d0_30");
    expect(ageBand(ageInDays(plusDays(31), origin))).toBe("d31_60");
    expect(ageBand(ageInDays(plusDays(60), origin))).toBe("d31_60");
    expect(ageBand(ageInDays(plusDays(61), origin))).toBe("d61_90");
    expect(ageBand(ageInDays(plusDays(90), origin))).toBe("d61_90");
    expect(ageBand(ageInDays(plusDays(91), origin))).toBe("d90_plus");
  });
});

describe("bucketByAge", () => {
  it("sums values into bands and totals match", () => {
    const asOf = plusDays(100);
    const items = [
      { d: plusDays(100), v: 1 }, // 0
      { d: plusDays(70), v: 10 }, // 30
      { d: plusDays(69), v: 100 }, // 31
      { d: plusDays(40), v: 1_000 }, // 60
      { d: plusDays(39), v: 10_000 }, // 61
      { d: plusDays(10), v: 100_000 }, // 90
      { d: plusDays(9), v: 1_000_000 }, // 91
      { d: plusDays(0), v: 10_000_000 }, // 100
    ];
    const b = bucketByAge(items, (i) => i.d, (i) => i.v, asOf);
    expect(b).toEqual({ d0_30: 11, d31_60: 1_100, d61_90: 110_000, d90_plus: 11_000_000 });
    const total = b.d0_30 + b.d31_60 + b.d61_90 + b.d90_plus;
    expect(total).toBe(items.reduce((s, i) => s + i.v, 0));
  });

  it("empty list → all bands zero", () => {
    expect(bucketByAge([], () => origin, () => 1, origin)).toEqual({
      d0_30: 0,
      d31_60: 0,
      d61_90: 0,
      d90_plus: 0,
    });
  });
});
