/**
 * Selling UI formatting + small parsing helpers. Pure and client-safe:
 * only depends on the pure domain units/format modules.
 */
import { formatLagosDate, formatLagosDateTime } from "@/lib/domain/format";
import { formatNaira, gramsToKg, kgToGrams, roundHalfUpKobo, type Grams, type Kobo } from "@/lib/domain/units";

export { formatLagosDate, formatLagosDateTime };

const KG_RE = /^\d{1,9}(\.\d{1,3})?$/;
const NAIRA_RE = /^\d{1,12}(\.\d{1,2})?$/;

function group(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** "1234.500" → "1,234.5 kg"; null/empty → "—". */
export function kg(value: string | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  const neg = value.startsWith("-");
  const body = neg ? value.slice(1) : value;
  const [int, frac = ""] = body.split(".");
  const f = frac.replace(/0+$/, "");
  return `${neg ? "-" : ""}${group(int)}${f ? `.${f}` : ""} kg`;
}

/** Grams → "1,234.5 kg". */
export function kgFromGrams(g: Grams): string {
  return kg(gramsToKg(g));
}

/** Integer kobo → "₦12,345.67"; null → "—". */
export function naira(kobo: Kobo | null | undefined): string {
  if (kobo === null || kobo === undefined) return "—";
  return formatNaira(kobo);
}

/** Lenient kg string → grams, or null when not a valid kg entry. */
export function parseKgInput(s: string | null | undefined): Grams | null {
  const t = (s ?? "").trim();
  if (!KG_RE.test(t)) return null;
  return kgToGrams(t);
}

/** Lenient kg string → grams, treating invalid/blank as 0. */
export function gramsOrZero(s: string | null | undefined): Grams {
  return parseKgInput(s) ?? 0;
}

/** "1,234.50" / "1234.5" → 123450 kobo, or null when invalid. Exact string math. */
export function nairaToKobo(s: string | null | undefined): Kobo | null {
  const t = (s ?? "").trim().replace(/,/g, "");
  if (!NAIRA_RE.test(t)) return null;
  const [whole, frac = ""] = t.split(".");
  const v = Number.parseInt(whole, 10) * 100 + Number.parseInt((frac + "00").slice(0, 2), 10);
  return Number.isSafeInteger(v) ? v : null;
}

/** 123450 kobo → "1234.50" (for input defaults). */
export function koboToNairaInput(kobo: Kobo): string {
  const whole = Math.trunc(kobo / 100);
  const cents = String(kobo % 100).padStart(2, "0");
  return cents === "00" ? String(whole) : `${whole}.${cents}`;
}

/** Same rule as the service: round half-up of grams × price-per-kg / 1000. */
export function lineAmount(grams: Grams, pricePerKgKobo: Kobo): Kobo {
  return roundHalfUpKobo((grams * pricePerKgKobo) / 1000);
}

/** grams → kg string for inputs (no trailing zeros). */
export function gramsToKgInput(g: Grams): string {
  const s = gramsToKg(g);
  return s.replace(/\.?0+$/, "") || "0";
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Calendar date "2026-10-08" → "08 Oct 2026" (no timezone shift). */
export function dateOnly(s: string | null | undefined): string {
  if (!s) return "—";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return s;
  return `${m[3]} ${MONTHS[Number(m[2]) - 1] ?? m[2]} ${m[1]}`;
}

/** Date | ISO string → Lagos "08 Oct 2026". */
export function lagosDate(d: Date | string | null | undefined): string {
  if (!d) return "—";
  return formatLagosDate(typeof d === "string" ? new Date(d) : d);
}

/** Date | ISO string → Lagos "08 Oct 2026, 14:05". */
export function lagosDateTime(d: Date | string | null | undefined): string {
  if (!d) return "—";
  return formatLagosDateTime(typeof d === "string" ? new Date(d) : d);
}

/** Percentage of covered/requested for progress bars, clamped 0..100. */
export function pct(part: number, whole: number): number {
  if (whole <= 0) return part > 0 ? 100 : 0;
  return Math.max(0, Math.min(100, Math.round((part / whole) * 100)));
}
