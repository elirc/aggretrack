/**
 * Payment allocation (DOMAIN-ENGINE §9). Pure.
 */
import { DomainError } from "./errors";
import type { Kobo } from "./units";

export interface OpenItem {
  id: string;
  date: Date;
  outstandingKobo: Kobo;
}

export interface PaymentAllocationResult {
  allocations: { id: string; amountKobo: Kobo }[];
  unallocatedKobo: Kobo;
}

function assertAmount(amountKobo: Kobo): void {
  if (!Number.isSafeInteger(amountKobo) || amountKobo < 0) {
    throw new DomainError("PAYMENT_ALLOCATION_INVALID", `payment amount must be a non-negative integer, got ${amountKobo}`);
  }
}

/** Oldest date first (tie → id asc); last allocation partial; leftover → unallocatedKobo. */
export function allocatePaymentFifo(amountKobo: Kobo, open: OpenItem[]): PaymentAllocationResult {
  assertAmount(amountKobo);
  const sorted = open
    .filter((o) => o.outstandingKobo > 0)
    .slice()
    .sort((a, b) => a.date.getTime() - b.date.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const allocations: { id: string; amountKobo: Kobo }[] = [];
  let remaining = amountKobo;
  for (const item of sorted) {
    if (remaining === 0) break;
    const take = Math.min(remaining, item.outstandingKobo);
    allocations.push({ id: item.id, amountKobo: take });
    remaining -= take;
  }
  return { allocations, unallocatedKobo: remaining };
}

/**
 * Manual override: each pick must reference an open item, be a positive
 * integer, and (aggregated per id) not exceed its outstanding; Σ picks ≤ amount.
 */
export function validateManualPaymentAllocation(
  amountKobo: Kobo,
  picks: { id: string; amountKobo: Kobo }[],
  open: OpenItem[],
): PaymentAllocationResult {
  assertAmount(amountKobo);
  const outstanding = new Map<string, number>();
  for (const o of open) outstanding.set(o.id, o.outstandingKobo);

  const used = new Map<string, number>();
  let sum = 0;
  for (const p of picks) {
    if (!Number.isSafeInteger(p.amountKobo) || p.amountKobo <= 0) {
      throw new DomainError("PAYMENT_ALLOCATION_INVALID", `allocation must be a positive integer, got ${p.amountKobo}`, {
        reason: "invalid_amount",
        id: p.id,
      });
    }
    const out = outstanding.get(p.id);
    if (out === undefined) {
      throw new DomainError("PAYMENT_ALLOCATION_INVALID", `item ${p.id} is not open`, { reason: "unknown_item", id: p.id });
    }
    const total = (used.get(p.id) ?? 0) + p.amountKobo;
    if (total > out) {
      throw new DomainError("PAYMENT_ALLOCATION_INVALID", `allocation to ${p.id} exceeds its outstanding`, {
        reason: "exceeds_outstanding",
        id: p.id,
        outstandingKobo: out,
      });
    }
    used.set(p.id, total);
    sum += p.amountKobo;
  }
  if (sum > amountKobo) {
    throw new DomainError("PAYMENT_ALLOCATION_INVALID", `allocations total ${sum} exceed payment ${amountKobo}`, {
      reason: "exceeds_payment",
      allocatedKobo: sum,
      amountKobo,
    });
  }
  return {
    allocations: picks.map((p) => ({ id: p.id, amountKobo: p.amountKobo })),
    unallocatedKobo: amountKobo - sum,
  };
}
