import { describe, expect, it } from "vitest";
import { allocateFifo, validateManualAllocation, type LotAvailability } from "@/lib/domain/allocation";
import { DomainError } from "@/lib/domain/errors";

const d = (iso: string) => new Date(iso);

const lots: LotAvailability[] = [
  { lotId: "lot-c", warehouseId: "w1", receivedAt: d("2026-03-01T00:00:00Z"), availableG: 5_000 },
  { lotId: "lot-a", warehouseId: "w1", receivedAt: d("2026-01-15T00:00:00Z"), availableG: 3_000 },
  { lotId: "lot-b", warehouseId: "w1", receivedAt: d("2026-02-01T00:00:00Z"), availableG: 2_000 },
];

function expectDomainError(fn: () => unknown, code: string): DomainError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(DomainError);
    expect((e as DomainError).code).toBe(code);
    return e as DomainError;
  }
  throw new Error(`expected DomainError ${code}`);
}

describe("allocateFifo", () => {
  it("takes the oldest lot first", () => {
    expect(allocateFifo(1_000, lots)).toEqual([{ lotId: "lot-a", warehouseId: "w1", grams: 1_000 }]);
  });

  it("breaks receivedAt ties by lotId asc regardless of input order", () => {
    const t = d("2026-01-01T00:00:00Z");
    const tied: LotAvailability[] = [
      { lotId: "z", warehouseId: "w1", receivedAt: t, availableG: 1_000 },
      { lotId: "m", warehouseId: "w1", receivedAt: t, availableG: 1_000 },
      { lotId: "b", warehouseId: "w1", receivedAt: t, availableG: 1_000 },
    ];
    expect(allocateFifo(1_500, tied)).toEqual([
      { lotId: "b", warehouseId: "w1", grams: 1_000 },
      { lotId: "m", warehouseId: "w1", grams: 500 },
    ]);
  });

  it("spills across multiple lots with a partial last lot", () => {
    expect(allocateFifo(6_000, lots)).toEqual([
      { lotId: "lot-a", warehouseId: "w1", grams: 3_000 },
      { lotId: "lot-b", warehouseId: "w1", grams: 2_000 },
      { lotId: "lot-c", warehouseId: "w1", grams: 1_000 },
    ]);
  });

  it("exact fill consumes every lot fully and stops", () => {
    const out = allocateFifo(10_000, lots);
    expect(out.map((l) => l.grams)).toEqual([3_000, 2_000, 5_000]);
    expect(out.reduce((s, l) => s + l.grams, 0)).toBe(10_000);
  });

  it("exact fill of the first lot does not touch the next", () => {
    expect(allocateFifo(3_000, lots)).toEqual([{ lotId: "lot-a", warehouseId: "w1", grams: 3_000 }]);
  });

  it("skips lots with zero or negative availability", () => {
    const withEmpty: LotAvailability[] = [
      { lotId: "old", warehouseId: "w1", receivedAt: d("2025-01-01T00:00:00Z"), availableG: 0 },
      { lotId: "older", warehouseId: "w1", receivedAt: d("2024-01-01T00:00:00Z"), availableG: -50 },
      ...lots,
    ];
    expect(allocateFifo(500, withEmpty)[0].lotId).toBe("lot-a");
  });

  it("throws INSUFFICIENT_STOCK with the exact shortfall", () => {
    const err = expectDomainError(() => allocateFifo(10_750, lots), "INSUFFICIENT_STOCK");
    expect(err.meta).toEqual({ shortfallG: 750 });
  });

  it("throws INSUFFICIENT_STOCK when no lots are available", () => {
    const err = expectDomainError(() => allocateFifo(1, []), "INSUFFICIENT_STOCK");
    expect(err.meta).toEqual({ shortfallG: 1 });
  });

  it("zero request allocates nothing", () => {
    expect(allocateFifo(0, lots)).toEqual([]);
  });

  it("does not mutate the input array order", () => {
    const copy = lots.map((l) => l.lotId);
    allocateFifo(6_000, lots);
    expect(lots.map((l) => l.lotId)).toEqual(copy);
  });
});

describe("validateManualAllocation", () => {
  it("accepts valid picks summing to the request", () => {
    const picks = [
      { lotId: "lot-c", warehouseId: "w1", grams: 4_000 },
      { lotId: "lot-b", warehouseId: "w1", grams: 1_000 },
    ];
    expect(validateManualAllocation(5_000, picks, lots)).toEqual(picks);
  });

  it("rejects a pick on an unlisted lot", () => {
    const err = expectDomainError(
      () => validateManualAllocation(100, [{ lotId: "nope", warehouseId: "w1", grams: 100 }], lots),
      "ALLOCATION_INVALID",
    );
    expect((err.meta as { reason: string }).reason).toBe("unknown_lot");
  });

  it("rejects a pick on the right lot but wrong warehouse", () => {
    expectDomainError(
      () => validateManualAllocation(100, [{ lotId: "lot-a", warehouseId: "w2", grams: 100 }], lots),
      "ALLOCATION_INVALID",
    );
  });

  it("rejects a pick exceeding the lot's availability", () => {
    const err = expectDomainError(
      () => validateManualAllocation(3_001, [{ lotId: "lot-a", warehouseId: "w1", grams: 3_001 }], lots),
      "INSUFFICIENT_STOCK",
    );
    expect((err.meta as { shortfallG: number }).shortfallG).toBe(1);
  });

  it("aggregates duplicate picks on one lot against its availability", () => {
    expectDomainError(
      () =>
        validateManualAllocation(
          4_000,
          [
            { lotId: "lot-b", warehouseId: "w1", grams: 1_500 },
            { lotId: "lot-b", warehouseId: "w1", grams: 1_500 },
            { lotId: "lot-a", warehouseId: "w1", grams: 1_000 },
          ],
          lots,
        ),
      "INSUFFICIENT_STOCK",
    );
  });

  it("rejects picks whose sum differs from the request (under and over)", () => {
    expectDomainError(
      () => validateManualAllocation(2_000, [{ lotId: "lot-a", warehouseId: "w1", grams: 1_999 }], lots),
      "ALLOCATION_INVALID",
    );
    expectDomainError(
      () => validateManualAllocation(2_000, [{ lotId: "lot-a", warehouseId: "w1", grams: 2_001 }], lots),
      "ALLOCATION_INVALID",
    );
  });

  it("rejects zero, negative and fractional pick grams", () => {
    for (const grams of [0, -5, 1.5]) {
      expectDomainError(
        () => validateManualAllocation(grams, [{ lotId: "lot-a", warehouseId: "w1", grams }], lots),
        "ALLOCATION_INVALID",
      );
    }
  });
});
