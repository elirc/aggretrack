/**
 * FIFO lot allocation (DOMAIN-ENGINE §3). Pure.
 */
import { DomainError } from "./errors";
import type { Grams } from "./units";

export interface LotAvailability {
  lotId: string;
  warehouseId: string;
  receivedAt: Date;
  availableG: Grams;
}

export interface AllocationLine {
  lotId: string;
  warehouseId: string;
  grams: Grams;
}

function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function key(lotId: string, warehouseId: string): string {
  return `${lotId}\u0000${warehouseId}`;
}

function assertRequested(requestedG: Grams): void {
  if (!Number.isSafeInteger(requestedG) || requestedG < 0) {
    throw new DomainError("ALLOCATION_INVALID", `requested grams must be a non-negative integer, got ${requestedG}`);
  }
}

/**
 * Oldest receivedAt first, tie-break lotId asc (then warehouseId asc).
 * Skips lots with availableG <= 0; last lot takes a partial.
 * Throws INSUFFICIENT_STOCK { shortfallG } when Σ available < requested.
 */
export function allocateFifo(requestedG: Grams, lots: LotAvailability[]): AllocationLine[] {
  assertRequested(requestedG);
  const usable = lots
    .filter((l) => l.availableG > 0)
    .slice()
    .sort(
      (a, b) =>
        a.receivedAt.getTime() - b.receivedAt.getTime() ||
        cmpStr(a.lotId, b.lotId) ||
        cmpStr(a.warehouseId, b.warehouseId),
    );

  const totalAvailable = usable.reduce((s, l) => s + l.availableG, 0);
  if (totalAvailable < requestedG) {
    const shortfallG = requestedG - totalAvailable;
    throw new DomainError(
      "INSUFFICIENT_STOCK",
      `Insufficient stock: short by ${shortfallG} g`,
      { shortfallG },
    );
  }

  const out: AllocationLine[] = [];
  let remaining = requestedG;
  for (const lot of usable) {
    if (remaining === 0) break;
    const take = Math.min(remaining, lot.availableG);
    out.push({ lotId: lot.lotId, warehouseId: lot.warehouseId, grams: take });
    remaining -= take;
  }
  return out;
}

/**
 * Manual picks: each must reference a listed lot+warehouse, be a positive
 * integer, and (aggregated per lot+warehouse) not exceed availableG;
 * Σ picks must equal requestedG. Returns the picks (copied) on success.
 */
export function validateManualAllocation(
  requestedG: Grams,
  picks: AllocationLine[],
  lots: LotAvailability[],
): AllocationLine[] {
  assertRequested(requestedG);
  const avail = new Map<string, number>();
  for (const l of lots) avail.set(key(l.lotId, l.warehouseId), l.availableG);

  const used = new Map<string, number>();
  let sum = 0;
  for (const p of picks) {
    if (!Number.isSafeInteger(p.grams) || p.grams <= 0) {
      throw new DomainError("ALLOCATION_INVALID", `pick grams must be a positive integer, got ${p.grams}`, {
        reason: "invalid_grams",
        lotId: p.lotId,
      });
    }
    const k = key(p.lotId, p.warehouseId);
    const a = avail.get(k);
    if (a === undefined) {
      throw new DomainError("ALLOCATION_INVALID", `lot ${p.lotId} is not available in warehouse ${p.warehouseId}`, {
        reason: "unknown_lot",
        lotId: p.lotId,
        warehouseId: p.warehouseId,
      });
    }
    const total = (used.get(k) ?? 0) + p.grams;
    if (total > a) {
      const shortfallG = total - Math.max(a, 0);
      throw new DomainError("INSUFFICIENT_STOCK", `pick exceeds available stock on lot ${p.lotId} by ${shortfallG} g`, {
        shortfallG,
        lotId: p.lotId,
        warehouseId: p.warehouseId,
      });
    }
    used.set(k, total);
    sum += p.grams;
  }
  if (sum !== requestedG) {
    throw new DomainError("ALLOCATION_INVALID", `picks total ${sum} g but ${requestedG} g requested`, {
      reason: "sum_mismatch",
      pickedG: sum,
      requestedG,
    });
  }
  return picks.map((p) => ({ lotId: p.lotId, warehouseId: p.warehouseId, grams: p.grams }));
}
