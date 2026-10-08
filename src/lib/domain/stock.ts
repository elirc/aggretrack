/**
 * Stock on hand (DOMAIN-ENGINE §2). Signs live in the movement rows.
 */
import { DomainError } from "./errors";
import type { Grams } from "./units";

/** on_hand = Σ movement grams (signed). */
export function sumMovements(movements: { kg: Grams }[]): Grams {
  let total = 0;
  for (const m of movements) {
    if (!Number.isSafeInteger(m.kg)) {
      throw new DomainError("INVALID_INPUT", `movement grams must be an integer, got ${m.kg}`);
    }
    total += m.kg;
  }
  return total;
}

/** available = on_hand − reserved. Throws STOCK_INVARIANT_BREACH if negative. */
export function availableGrams(onHandG: Grams, reservedG: Grams): Grams {
  if (!Number.isSafeInteger(onHandG) || !Number.isSafeInteger(reservedG)) {
    throw new DomainError("INVALID_INPUT", "onHandG and reservedG must be integers");
  }
  const available = onHandG - reservedG;
  if (available < 0) {
    throw new DomainError(
      "STOCK_INVARIANT_BREACH",
      `Available stock is negative (on hand ${onHandG} g, reserved ${reservedG} g)`,
      { onHandG, reservedG },
    );
  }
  return available;
}
