/**
 * Ageing (DOMAIN-ENGINE §10). Pure.
 */

export type AgeBand = "d0_30" | "d31_60" | "d61_90" | "d90_plus";

export const AGE_BANDS: readonly AgeBand[] = ["d0_30", "d31_60", "d61_90", "d90_plus"];

const DAY_MS = 86_400_000;

function utcMidnight(d: Date): number {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** floor((utcMidnight(asOf) − utcMidnight(origin)) / 1 day), min 0. */
export function ageInDays(asOf: Date, origin: Date): number {
  const diff = Math.floor((utcMidnight(asOf) - utcMidnight(origin)) / DAY_MS);
  return diff < 0 ? 0 : diff;
}

/** 0–30 → d0_30, 31–60 → d31_60, 61–90 → d61_90, ≥91 → d90_plus. */
export function ageBand(days: number): AgeBand {
  if (days <= 30) return "d0_30";
  if (days <= 60) return "d31_60";
  if (days <= 90) return "d61_90";
  return "d90_plus";
}

export function bucketByAge<T>(
  items: T[],
  getDate: (t: T) => Date,
  getValue: (t: T) => number,
  asOf: Date,
): Record<AgeBand, number> {
  const out: Record<AgeBand, number> = { d0_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0 };
  for (const it of items) {
    out[ageBand(ageInDays(asOf, getDate(it)))] += getValue(it);
  }
  return out;
}
