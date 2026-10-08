/**
 * Margin (DOMAIN-ENGINE §11). Pure.
 */
import { DomainError } from "./errors";
import type { Grams, Kobo } from "./units";

/**
 * roundHalfUpKobo(g × rate / 1000). The landed rate is numeric(14,4) kobo/kg,
 * so it is scaled to integer ten-thousandths and the product is computed in
 * BigInt — exact for any 4-dp rate, no float drift at the rounding boundary.
 */
export function dispatchedCostKobo(dispatchedG: Grams, landedCostPerKgKobo: number): Kobo {
  if (!Number.isSafeInteger(dispatchedG)) {
    throw new DomainError("INVALID_INPUT", `dispatchedG must be an integer, got ${dispatchedG}`);
  }
  if (!Number.isFinite(landedCostPerKgKobo) || landedCostPerKgKobo < 0) {
    throw new DomainError("INVALID_INPUT", `landed rate must be >= 0, got ${landedCostPerKgKobo}`);
  }
  const rate4 = BigInt(Math.round(landedCostPerKgKobo * 10_000));
  const g = BigInt(dispatchedG);
  const neg = g < BigInt(0);
  const num = (neg ? -g : g) * rate4; // kobo × 10^7
  const DEN = BigInt(10_000_000);
  const rounded = (num + DEN / BigInt(2)) / DEN;
  const n = Number(rounded);
  return neg && n !== 0 ? -n : n;
}

/** margin = revenue − cost − expenses; percent = margin / revenue × 100 (0 revenue → 0). */
export function computeMargin(
  revenueKobo: Kobo,
  costKobo: Kobo,
  expensesKobo: Kobo,
): { marginKobo: Kobo; marginPercent: number } {
  const marginKobo = revenueKobo - costKobo - expensesKobo;
  const marginPercent = revenueKobo === 0 ? 0 : (marginKobo / revenueKobo) * 100;
  return { marginKobo, marginPercent };
}
