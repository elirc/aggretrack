/**
 * Net weight & line amount (DOMAIN-ENGINE §1). Pure, integer math only.
 */
import { DomainError } from "./errors";
import { kgToGrams, type Grams, type Kobo } from "./units";

export interface DeductionInput {
  reason: "moisture" | "foreign_matter" | "sack_weight" | "other";
  grams: Grams;
}

function assertNonNegInt(name: string, v: number): void {
  if (!Number.isSafeInteger(v) || v < 0) {
    throw new DomainError("INVALID_INPUT", `${name} must be a non-negative integer, got ${v}`);
  }
}

/** net = gross − Σ deductions. Throws NET_WEIGHT_NEGATIVE if net < 0. */
export function computeNetGrams(grossG: Grams, deductions: DeductionInput[]): Grams {
  assertNonNegInt("grossG", grossG);
  let total = 0;
  for (const d of deductions) {
    assertNonNegInt(`deduction(${d.reason}).grams`, d.grams);
    total += d.grams;
  }
  const net = grossG - total;
  if (net < 0) {
    throw new DomainError(
      "NET_WEIGHT_NEGATIVE",
      `Deductions (${total} g) exceed gross weight (${grossG} g)`,
      { grossG, deductionsG: total },
    );
  }
  return net;
}

/**
 * Amount = roundHalfUpKobo(netG × pricePerKgKobo / 1000).
 * Computed in BigInt so large weight × price products stay exact.
 */
export function computeLineAmountKobo(netG: Grams, pricePerKgKobo: Kobo): Kobo {
  assertNonNegInt("netG", netG);
  assertNonNegInt("pricePerKgKobo", pricePerKgKobo);
  const product = BigInt(netG) * BigInt(pricePerKgKobo);
  const amount = (product + BigInt(500)) / BigInt(1000); // floor((x + 500) / 1000) == half-up for x >= 0
  const n = Number(amount);
  if (!Number.isSafeInteger(n)) {
    throw new DomainError("INVALID_INPUT", "Line amount out of safe integer range");
  }
  return n;
}

/** bags × bag_type.sack_weight_kg, in integer grams. */
export function computeSackDeductionGrams(bags: number, sackWeightKgPerBag: string): Grams {
  assertNonNegInt("bags", bags);
  const perBagG = kgToGrams(sackWeightKgPerBag);
  if (perBagG < 0) {
    throw new DomainError("INVALID_INPUT", `sack weight must be >= 0, got ${sackWeightKgPerBag}`);
  }
  return bags * perBagG;
}
