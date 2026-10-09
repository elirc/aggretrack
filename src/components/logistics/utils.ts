import { formatDocDate } from "@/lib/domain/format";
import { formatNaira, kgToGrams, type Kobo } from "@/lib/domain/units";

/**
 * Client-safe helpers shared by the logistics, alerts, audit and dashboard UI
 * (P3-D). Pure — safe in server and client components.
 */

/** Naira typed by a person: "1,250" or "1250.5" (max 2 decimals). */
export const NAIRA_RE = /^\d{1,13}(\.\d{1,2})?$/;

/** "1,250.50" → 125050 kobo, exact (string maths, no float). null when invalid. */
export function nairaToKobo(raw: string): Kobo | null {
  const s = raw.trim().replace(/,/g, "");
  if (!NAIRA_RE.test(s)) return null;
  const [whole, frac = ""] = s.split(".");
  const kobo = Number.parseInt(whole, 10) * 100 + Number.parseInt((frac + "00").slice(0, 2), 10);
  return Number.isSafeInteger(kobo) ? kobo : null;
}

/** 125050 → "1250.50" for form defaults ("" for 0 when blankZero). */
export function koboToNairaInput(kobo: Kobo, blankZero = false): string {
  if (blankZero && kobo === 0) return "";
  const whole = Math.trunc(kobo / 100);
  const cents = kobo % 100;
  return cents === 0 ? String(whole) : `${whole}.${String(cents).padStart(2, "0")}`;
}

/** Money or the em-dash used when prices are hidden. */
export function money(kobo: Kobo | null | undefined): string {
  return kobo === null || kobo === undefined ? "—" : formatNaira(kobo);
}

/** "1234.500" → "1,234.5 kg". */
export function kgLabel(kg: string | null | undefined): string {
  if (kg === null || kg === undefined || kg === "") return "—";
  const trimmed = kg.includes(".") ? kg.replace(/\.?0+$/, "") : kg;
  const neg = trimmed.startsWith("-");
  const body = neg ? trimmed.slice(1) : trimmed;
  const [int, frac] = body.split(".");
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${neg ? "-" : ""}${frac ? `${grouped}.${frac}` : grouped} kg`;
}

/** Cost per kg in kobo (rounded half-up) or null when there is no weight. */
export function costPerKgKobo(costKobo: Kobo, kg: string): Kobo | null {
  const grams = kgToGrams(kg);
  if (grams <= 0) return null;
  return Math.round((costKobo * 1000) / grams);
}

/** Today's Lagos calendar date, yyyy-mm-dd. */
export function todayLagos(): string {
  return formatDocDate(new Date());
}

/** "2026-10-08" → "08 Oct 2026" without timezone drift. */
export function isoDateLabel(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
}
