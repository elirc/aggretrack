/**
 * Display formatters: kg, naira, Lagos-local dates. Pure.
 */
import { formatNaira, gramsToKg, type Grams, type Kobo } from "./units";

const LAGOS_TZ = "Africa/Lagos";

function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** 1234500 g → "1,234.500 kg". */
export function formatKg(grams: Grams): string {
  const s = gramsToKg(grams);
  const neg = s.startsWith("-");
  const [whole, frac] = (neg ? s.slice(1) : s).split(".");
  return `${neg ? "-" : ""}${groupThousands(whole)}.${frac} kg`;
}

/** "₦12,345.67" from integer kobo. */
export function formatNairaFromKobo(kobo: Kobo): string {
  return formatNaira(kobo);
}

type Parts = Record<"year" | "month" | "day" | "hour" | "minute", string>;

function lagosParts(date: Date, month: "short" | "2-digit"): Parts {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: LAGOS_TZ,
    year: "numeric",
    month,
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const out: Parts = { year: "", month: "", day: "", hour: "", minute: "" };
  for (const p of fmt.formatToParts(date)) {
    if (p.type in out) out[p.type as keyof Parts] = p.value;
  }
  return out;
}

/** "08 Oct 2026" in Africa/Lagos. */
export function formatLagosDate(date: Date): string {
  const p = lagosParts(date, "short");
  return `${p.day} ${p.month} ${p.year}`;
}

/** "08 Oct 2026, 14:05" in Africa/Lagos (24h). */
export function formatLagosDateTime(date: Date): string {
  const p = lagosParts(date, "short");
  return `${p.day} ${p.month} ${p.year}, ${p.hour}:${p.minute}`;
}

/** "2026-10-08" — Lagos calendar date. */
export function formatDocDate(date: Date): string {
  const p = lagosParts(date, "2-digit");
  return `${p.year}-${p.month}-${p.day}`;
}
