/**
 * Share a cost pool across items by weight (DOMAIN-ENGINE §8).
 * Largest-remainder method in BigInt: Σ shares === total exactly.
 */
import { DomainError } from "./errors";
import type { Grams, Kobo } from "./units";

export function shareByWeight(totalKobo: Kobo, items: { id: string; grams: Grams }[]): Map<string, Kobo> {
  if (!Number.isSafeInteger(totalKobo) || totalKobo < 0) {
    throw new DomainError("INVALID_INPUT", `totalKobo must be a non-negative integer, got ${totalKobo}`);
  }
  const seen = new Set<string>();
  let sumG = BigInt(0);
  for (const it of items) {
    if (!Number.isSafeInteger(it.grams) || it.grams < 0) {
      throw new DomainError("INVALID_INPUT", `grams must be a non-negative integer for ${it.id}, got ${it.grams}`);
    }
    if (seen.has(it.id)) {
      throw new DomainError("INVALID_INPUT", `duplicate item id ${it.id}`);
    }
    seen.add(it.id);
    sumG += BigInt(it.grams);
  }

  const result = new Map<string, Kobo>();
  // All-zero weights (or no items): every share 0, total left unshared — caller treats as no-op.
  if (sumG === BigInt(0)) {
    for (const it of items) result.set(it.id, 0);
    return result;
  }

  const total = BigInt(totalKobo);
  const rows = items.map((it) => {
    const num = total * BigInt(it.grams);
    return { id: it.id, floor: num / sumG, rem: num % sumG };
  });

  let distributed = BigInt(0);
  for (const r of rows) distributed += r.floor;
  let leftover = Number(total - distributed); // < items.length

  const order = rows
    .slice()
    .sort((a, b) => (a.rem > b.rem ? -1 : a.rem < b.rem ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const bonus = new Set<string>();
  for (const r of order) {
    if (leftover <= 0) break;
    bonus.add(r.id);
    leftover -= 1;
  }

  for (const r of rows) result.set(r.id, Number(r.floor) + (bonus.has(r.id) ? 1 : 0));
  return result;
}
