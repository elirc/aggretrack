import { DomainError } from "@/lib/domain/errors";
import type { Grams, Kobo } from "@/lib/domain/units";
import {
  computeLineAmountKobo,
  computeNetGrams,
  computeSackDeductionGrams,
  type DeductionInput,
} from "@/lib/domain/weights";

import { parseKgToGrams, parseNairaToKobo } from "./format";

/**
 * Client-side live math for the purchase line editor. Uses the SAME pure
 * domain functions the server save path uses (src/lib/domain/weights.ts):
 *
 *   net    = gross − Σ deductions − (bags × sack weight, when the line has a
 *            bag type and no explicit sack_weight deduction row)
 *   amount = round_half_up(net_g × price_kobo_per_kg / 1000)
 */

export type DeductionReason = DeductionInput["reason"];

export type LineDraft = {
  bagTypeId: string;
  bags: string;
  grossKg: string;
  priceNaira: string;
  deductions: Array<{ reason: DeductionReason; kg: string }>;
};

export type LineCalc = {
  grossG: Grams | null;
  /** Σ typed deduction rows (valid ones). */
  manualDeductionG: Grams;
  /** bags × sack weight added automatically (0 when not applicable). */
  autoSackG: Grams;
  sackWeightPerBagKg: string | null;
  bags: number;
  netG: Grams | null;
  priceKobo: Kobo | null;
  amountKobo: Kobo | null;
  error: string | null;
};

export function parseBags(raw: string): number | null {
  const s = raw.trim();
  if (s === "") return 0;
  if (!/^\d{1,6}$/.test(s)) return null;
  return Number(s);
}

export function calcLine(line: LineDraft, sackWeightByBagType: ReadonlyMap<string, string>): LineCalc {
  const grossG = parseKgToGrams(line.grossKg);
  const bags = parseBags(line.bags) ?? 0;
  const priceKobo = parseNairaToKobo(line.priceNaira);

  const deductions: DeductionInput[] = [];
  let manualDeductionG = 0;
  for (const d of line.deductions) {
    const g = parseKgToGrams(d.kg);
    if (g === null) continue;
    deductions.push({ reason: d.reason, grams: g });
    manualDeductionG += g;
  }

  let autoSackG = 0;
  const sackWeightPerBagKg = line.bagTypeId ? (sackWeightByBagType.get(line.bagTypeId) ?? null) : null;
  const hasExplicitSack = line.deductions.some((d) => d.reason === "sack_weight");
  if (sackWeightPerBagKg !== null && !hasExplicitSack && bags > 0) {
    autoSackG = computeSackDeductionGrams(bags, sackWeightPerBagKg);
    if (autoSackG > 0) deductions.push({ reason: "sack_weight", grams: autoSackG });
  }

  const base: LineCalc = {
    grossG,
    manualDeductionG,
    autoSackG,
    sackWeightPerBagKg,
    bags,
    netG: null,
    priceKobo,
    amountKobo: null,
    error: null,
  };
  if (grossG === null) return base;

  let netG: Grams;
  try {
    netG = computeNetGrams(grossG, deductions);
  } catch (err) {
    if (err instanceof DomainError && err.code === "NET_WEIGHT_NEGATIVE") {
      return { ...base, error: "Deductions are more than the gross weight" };
    }
    return { ...base, error: "Check the weights" };
  }
  const amountKobo = priceKobo === null ? null : computeLineAmountKobo(netG, priceKobo);
  return { ...base, netG, amountKobo };
}
