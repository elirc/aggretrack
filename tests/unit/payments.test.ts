import { describe, expect, it } from "vitest";
import { allocatePaymentFifo, validateManualPaymentAllocation, type OpenItem } from "@/lib/domain/payments";
import { DomainError } from "@/lib/domain/errors";

const open: OpenItem[] = [
  { id: "inv-3", date: new Date("2026-03-01T00:00:00Z"), outstandingKobo: 30_000 },
  { id: "inv-1", date: new Date("2026-01-01T00:00:00Z"), outstandingKobo: 10_000 },
  { id: "inv-2", date: new Date("2026-02-01T00:00:00Z"), outstandingKobo: 20_000 },
];

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(DomainError);
    return (e as DomainError).code;
  }
  throw new Error("expected throw");
}

describe("allocatePaymentFifo", () => {
  it("pays oldest first", () => {
    expect(allocatePaymentFifo(10_000, open)).toEqual({
      allocations: [{ id: "inv-1", amountKobo: 10_000 }],
      unallocatedKobo: 0,
    });
  });

  it("last allocation is partial", () => {
    expect(allocatePaymentFifo(35_000, open)).toEqual({
      allocations: [
        { id: "inv-1", amountKobo: 10_000 },
        { id: "inv-2", amountKobo: 20_000 },
        { id: "inv-3", amountKobo: 5_000 },
      ],
      unallocatedKobo: 0,
    });
  });

  it("overpayment leaves the excess unallocated", () => {
    const r = allocatePaymentFifo(75_000, open);
    expect(r.allocations.map((a) => a.amountKobo)).toEqual([10_000, 20_000, 30_000]);
    expect(r.unallocatedKobo).toBe(15_000);
  });

  it("empty open list → everything unallocated", () => {
    expect(allocatePaymentFifo(12_345, [])).toEqual({ allocations: [], unallocatedKobo: 12_345 });
  });

  it("zero payment allocates nothing", () => {
    expect(allocatePaymentFifo(0, open)).toEqual({ allocations: [], unallocatedKobo: 0 });
  });

  it("same date tie-breaks by id asc and skips fully-paid items", () => {
    const t = new Date("2026-05-05T00:00:00Z");
    const r = allocatePaymentFifo(150, [
      { id: "b", date: t, outstandingKobo: 100 },
      { id: "z", date: new Date("2020-01-01T00:00:00Z"), outstandingKobo: 0 },
      { id: "a", date: t, outstandingKobo: 100 },
    ]);
    expect(r.allocations).toEqual([
      { id: "a", amountKobo: 100 },
      { id: "b", amountKobo: 50 },
    ]);
  });

  it("rejects negative or fractional payments", () => {
    expect(code(() => allocatePaymentFifo(-1, open))).toBe("PAYMENT_ALLOCATION_INVALID");
    expect(code(() => allocatePaymentFifo(1.5, open))).toBe("PAYMENT_ALLOCATION_INVALID");
  });
});

describe("validateManualPaymentAllocation", () => {
  it("accepts valid picks and reports the remainder as unallocated", () => {
    expect(
      validateManualPaymentAllocation(
        25_000,
        [
          { id: "inv-3", amountKobo: 15_000 },
          { id: "inv-1", amountKobo: 5_000 },
        ],
        open,
      ),
    ).toEqual({
      allocations: [
        { id: "inv-3", amountKobo: 15_000 },
        { id: "inv-1", amountKobo: 5_000 },
      ],
      unallocatedKobo: 5_000,
    });
  });

  it("rejects Σ picks > payment amount", () => {
    expect(
      code(() =>
        validateManualPaymentAllocation(
          10_000,
          [
            { id: "inv-1", amountKobo: 6_000 },
            { id: "inv-2", amountKobo: 6_000 },
          ],
          open,
        ),
      ),
    ).toBe("PAYMENT_ALLOCATION_INVALID");
  });

  it("rejects a pick above the item's outstanding (incl. aggregated duplicates)", () => {
    expect(code(() => validateManualPaymentAllocation(50_000, [{ id: "inv-1", amountKobo: 10_001 }], open))).toBe(
      "PAYMENT_ALLOCATION_INVALID",
    );
    expect(
      code(() =>
        validateManualPaymentAllocation(
          50_000,
          [
            { id: "inv-1", amountKobo: 6_000 },
            { id: "inv-1", amountKobo: 6_000 },
          ],
          open,
        ),
      ),
    ).toBe("PAYMENT_ALLOCATION_INVALID");
  });

  it("rejects unknown items and non-positive amounts", () => {
    expect(code(() => validateManualPaymentAllocation(100, [{ id: "nope", amountKobo: 100 }], open))).toBe(
      "PAYMENT_ALLOCATION_INVALID",
    );
    expect(code(() => validateManualPaymentAllocation(100, [{ id: "inv-1", amountKobo: 0 }], open))).toBe(
      "PAYMENT_ALLOCATION_INVALID",
    );
  });
});
