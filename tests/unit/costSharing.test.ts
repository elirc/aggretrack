import { describe, expect, it } from "vitest";
import { shareByWeight } from "@/lib/domain/costSharing";
import { DomainError } from "@/lib/domain/errors";

const sum = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0);

describe("shareByWeight", () => {
  it("Σ shares === total exactly over many odd totals × uneven weights", () => {
    const weightSets = [
      [1, 1, 1],
      [1, 2, 3, 4, 5, 6, 7],
      [96_200, 3_000, 47, 1],
      [333_333, 333_333, 333_334],
      [7, 11, 13, 17, 19, 23],
      [1, 999_999_999_999],
      [250, 0, 750, 0, 1],
    ];
    const totals = [1, 3, 7, 101, 9_999, 123_457, 1_000_001, 987_654_321, 99_999_999_999];
    for (const ws of weightSets) {
      const items = ws.map((g, i) => ({ id: `lot-${String(i).padStart(2, "0")}`, grams: g }));
      for (const t of totals) {
        const shares = shareByWeight(t, items);
        expect(sum(shares)).toBe(t);
        for (const v of shares.values()) {
          expect(Number.isInteger(v)).toBe(true);
          expect(v).toBeGreaterThanOrEqual(0);
        }
      }
    }
    // pseudo-random sweep (deterministic LCG)
    let seed = 42;
    const rnd = (n: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % n;
    };
    for (let k = 0; k < 300; k++) {
      const n = 1 + rnd(9);
      const items = Array.from({ length: n }, (_, i) => ({ id: `x${i}`, grams: 1 + rnd(500_000) }));
      const total = 1 + 2 * rnd(50_000_000); // odd
      expect(sum(shareByWeight(total, items))).toBe(total);
    }
  });

  it("is proportional: each share within 1 kobo of the exact proportional value", () => {
    const items = [
      { id: "a", grams: 10_000 },
      { id: "b", grams: 30_000 },
      { id: "c", grams: 60_000 },
    ];
    const shares = shareByWeight(1_000_000, items);
    expect(shares.get("a")).toBe(100_000);
    expect(shares.get("b")).toBe(300_000);
    expect(shares.get("c")).toBe(600_000);

    const uneven = [
      { id: "a", grams: 17 },
      { id: "b", grams: 29 },
      { id: "c", grams: 54 },
    ];
    const s2 = shareByWeight(12_345, uneven);
    for (const it of uneven) {
      const exact = (12_345 * it.grams) / 100;
      expect(Math.abs(s2.get(it.id)! - exact)).toBeLessThan(1);
    }
  });

  it("largest remainder gets the leftover kobo", () => {
    // 10 × [1,2,7]/10 = 1, 2, 7 exact; use total 11: raw 1.1, 2.2, 7.7 → floors 1,2,7 (=10), leftover 1 → c (.7)
    const s = shareByWeight(11, [
      { id: "a", grams: 1 },
      { id: "b", grams: 2 },
      { id: "c", grams: 7 },
    ]);
    expect([s.get("a"), s.get("b"), s.get("c")]).toEqual([1, 2, 8]);
  });

  it("ties on remainder go to the lower id, independent of input order", () => {
    const items = [
      { id: "c", grams: 1 },
      { id: "a", grams: 1 },
      { id: "b", grams: 1 },
    ];
    const s = shareByWeight(2, items);
    expect([s.get("a"), s.get("b"), s.get("c")]).toEqual([1, 1, 0]);
    const s2 = shareByWeight(2, [...items].reverse());
    expect([...s2.entries()].sort()).toEqual([...s.entries()].sort());
  });

  it("is deterministic across repeated calls", () => {
    const items = [
      { id: "l1", grams: 333 },
      { id: "l2", grams: 333 },
      { id: "l3", grams: 334 },
    ];
    const first = [...shareByWeight(1_001, items).entries()];
    for (let i = 0; i < 5; i++) expect([...shareByWeight(1_001, items).entries()]).toEqual(first);
  });

  it("single item gets the whole total", () => {
    expect(shareByWeight(987_654, [{ id: "only", grams: 42 }]).get("only")).toBe(987_654);
  });

  it("zero-weight items get 0 while others share the total", () => {
    const s = shareByWeight(1_000, [
      { id: "a", grams: 0 },
      { id: "b", grams: 500 },
      { id: "c", grams: 0 },
    ]);
    expect(s.get("a")).toBe(0);
    expect(s.get("b")).toBe(1_000);
    expect(s.get("c")).toBe(0);
  });

  it("all-zero weights → every share 0 (total left unshared)", () => {
    const s = shareByWeight(5_000, [
      { id: "a", grams: 0 },
      { id: "b", grams: 0 },
    ]);
    expect([...s.values()]).toEqual([0, 0]);
    expect(shareByWeight(5_000, []).size).toBe(0);
  });

  it("zero total → all zeros", () => {
    const s = shareByWeight(0, [
      { id: "a", grams: 3 },
      { id: "b", grams: 4 },
    ]);
    expect(sum(s)).toBe(0);
  });

  it("rejects negative totals/weights and duplicate ids", () => {
    expect(() => shareByWeight(-1, [{ id: "a", grams: 1 }])).toThrow(DomainError);
    expect(() => shareByWeight(1, [{ id: "a", grams: -1 }])).toThrow(DomainError);
    expect(() =>
      shareByWeight(1, [
        { id: "a", grams: 1 },
        { id: "a", grams: 2 },
      ]),
    ).toThrow(DomainError);
  });
});
