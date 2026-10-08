/**
 * Numeric representation (DOMAIN-ENGINE §0).
 *
 * Floats are forbidden for money/weights in domain math.
 * - Money: integer kobo (`Kobo`). Safe to 2^53 kobo ≈ ₦90 trillion.
 * - Weights: integer grams (`Grams`). 1 kg = 1000 g; DB numeric(12,3) kg ↔ grams losslessly.
 * - The single non-integer money value is lots.landed_cost_per_kg_kobo numeric(14,4)
 *   (kobo per kg). Landed-rate math multiplies grams × rate / 1000 and then
 *   applies roundHalfUpKobo, so the float only ever touches a final rounding step.
 */

export type Kobo = number; // integer kobo
export type Grams = number; // integer grams

/** Symmetric half-up rounding to an integer kobo value. */
export function roundHalfUpKobo(x: number): Kobo {
  if (!Number.isFinite(x)) {
    throw new Error(`roundHalfUpKobo: not a finite number: ${x}`);
  }
  if (x === 0) return 0;
  return Math.sign(x) * Math.floor(Math.abs(x) + 0.5);
}

/**
 * Parse a kg value (DB numeric(12,3) string or a number) into integer grams.
 * Accepts negative values (stock movements are signed). Throws on garbage.
 * Values with more than 3 decimals are rounded half-up at the gram.
 */
export function kgToGrams(kg: string | number): Grams {
  if (typeof kg === "number") {
    if (!Number.isFinite(kg)) throw new Error(`kgToGrams: not finite: ${kg}`);
    return kg === 0 ? 0 : Math.sign(kg) * Math.floor(Math.abs(kg) * 1000 + 0.5);
  }
  const s = kg.trim();
  if (!/^-?\d+(\.\d+)?$/.test(s)) {
    throw new Error(`kgToGrams: not a decimal string: "${kg}"`);
  }
  const neg = s.startsWith("-");
  const body = neg ? s.slice(1) : s;
  const [intPart, fracPart = ""] = body.split(".");
  const frac4 = (fracPart + "0000").slice(0, 4); // 3 gram digits + 1 rounding digit
  let grams =
    Number.parseInt(intPart, 10) * 1000 + Number.parseInt(frac4.slice(0, 3), 10);
  if (frac4.charCodeAt(3) >= 53 /* '5' */) grams += 1;
  if (!Number.isSafeInteger(grams)) {
    throw new Error(`kgToGrams: out of safe range: "${kg}"`);
  }
  return neg ? -grams : grams;
}

/** Format integer grams as a kg string with exactly 3 decimals, for numeric(12,3) binds. */
export function gramsToKg(g: Grams): string {
  if (!Number.isSafeInteger(g)) {
    throw new Error(`gramsToKg: not an integer gram value: ${g}`);
  }
  const neg = g < 0;
  const a = Math.abs(g);
  const whole = Math.trunc(a / 1000);
  const rem = String(a % 1000).padStart(3, "0");
  return `${neg ? "-" : ""}${whole}.${rem}`;
}

/** Parse lots.landed_cost_per_kg_kobo (numeric(14,4) string) into a kobo/kg rate. */
export function parseLandedRate(s: string | number): number {
  const n = typeof s === "number" ? s : Number(s);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`parseLandedRate: invalid rate: "${s}"`);
  }
  return n;
}

/** "₦12,345.67" from integer kobo. Exact — no float division of large values. */
export function formatNaira(kobo: Kobo): string {
  if (!Number.isSafeInteger(kobo)) {
    throw new Error(`formatNaira: not an integer kobo value: ${kobo}`);
  }
  const neg = kobo < 0;
  const a = Math.abs(kobo);
  const whole = Math.trunc(a / 100);
  const cents = String(a % 100).padStart(2, "0");
  return `${neg ? "-" : ""}₦${whole.toLocaleString("en-NG")}.${cents}`;
}
