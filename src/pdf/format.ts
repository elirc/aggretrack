/**
 * PDF-local display helpers. Pure, import-light (only domain/units).
 *
 * The built-in Helvetica font (WinAnsi encoding) has no glyph for the naira
 * sign, so PDFs print "NGN 12,345.67" instead of "₦12,345.67". This keeps the
 * renderer fully offline (no Font.register).
 */
import { formatNaira, gramsToKg, type Grams, type Kobo } from "../lib/domain/units";

/** Date value carried in PDF props: "YYYY-MM-DD" (calendar date) or an ISO timestamp. JSON-safe. */
export type PdfDate = string;

const LAGOS_TZ = "Africa/Lagos";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const CALENDAR_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** "NGN 12,345.67" from integer kobo. */
export function pdfNaira(kobo: Kobo): string {
  return formatNaira(kobo).replace("₦", "NGN ");
}

function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** 1234500 g → "1,234.500" (3 decimals, no unit). */
export function pdfKg(grams: Grams): string {
  const s = gramsToKg(grams);
  const neg = s.startsWith("-");
  const [whole, frac] = (neg ? s.slice(1) : s).split(".");
  return `${neg ? "-" : ""}${groupThousands(whole)}.${frac}`;
}

type LagosParts = { year: string; month: string; day: string; hour: string; minute: string };

function lagosParts(value: PdfDate | Date): LagosParts | null {
  if (typeof value === "string") {
    const m = CALENDAR_DATE_RE.exec(value);
    if (m) return { year: m[1], month: m[2], day: m[3], hour: "00", minute: "00" };
  }
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: LAGOS_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const out: LagosParts = { year: "", month: "", day: "", hour: "", minute: "" };
  for (const p of fmt.formatToParts(d)) {
    if (p.type in out) out[p.type as keyof LagosParts] = p.value;
  }
  return out;
}

/** "08 Oct 2026" (Africa/Lagos). Calendar dates are printed as-is, never tz-shifted. */
export function pdfDate(value: PdfDate | Date | null | undefined): string {
  if (value == null || value === "") return "-";
  const p = lagosParts(value);
  if (!p) return String(value);
  return `${p.day} ${MONTHS[Number(p.month) - 1]} ${p.year}`;
}

/** "08 Oct 2026, 14:05" (Africa/Lagos, 24h). */
export function pdfDateTime(value: PdfDate | Date | null | undefined): string {
  if (value == null || value === "") return "-";
  if (typeof value === "string" && CALENDAR_DATE_RE.test(value)) return pdfDate(value);
  const p = lagosParts(value);
  if (!p) return String(value);
  return `${p.day} ${MONTHS[Number(p.month) - 1]} ${p.year}, ${p.hour}:${p.minute}`;
}

/** Sortable "YYYY-MM-DD HH:mm" key in Lagos time (unparseable values sort last). */
export function lagosSortKey(value: PdfDate): string {
  const p = lagosParts(value);
  if (!p) return "9999-99-99 99:99";
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

// ---------------------------------------------------------------------------
// Amount in words (Nigerian invoice convention: "... naira and ... kobo only")

const ONES = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen",
];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
const SCALES = ["", "thousand", "million", "billion", "trillion"];

function underThousand(n: number): string {
  const parts: string[] = [];
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  if (hundreds > 0) parts.push(`${ONES[hundreds]} hundred`);
  if (rest > 0) {
    if (hundreds > 0) parts.push("and");
    if (rest < 20) parts.push(ONES[rest]);
    else {
      const t = Math.floor(rest / 10);
      const o = rest % 10;
      parts.push(o ? `${TENS[t]}-${ONES[o]}` : TENS[t]);
    }
  }
  return parts.join(" ");
}

/** Non-negative integer → English words ("one thousand, two hundred and five"). */
export function integerToWords(n: number): string {
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`integerToWords: invalid ${n}`);
  if (n === 0) return "zero";
  const groups: string[] = [];
  let scale = 0;
  let rest = n;
  while (rest > 0) {
    const chunk = rest % 1000;
    if (chunk > 0) {
      if (scale >= SCALES.length) throw new Error(`integerToWords: too large ${n}`);
      const words = underThousand(chunk);
      groups.unshift(SCALES[scale] ? `${words} ${SCALES[scale]}` : words);
    }
    rest = Math.floor(rest / 1000);
    scale += 1;
  }
  // British convention: "one thousand and five" when the last group is < 100.
  const last = n % 1000;
  if (groups.length > 1 && last > 0 && last < 100) {
    const tail = groups.pop() as string;
    return `${groups.join(", ")} and ${tail}`;
  }
  return groups.join(", ");
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** 1234550 kobo → "Twelve thousand, three hundred and forty-five naira, fifty kobo only". */
export function amountInWords(kobo: Kobo): string {
  if (!Number.isSafeInteger(kobo)) throw new Error(`amountInWords: not an integer kobo value: ${kobo}`);
  const neg = kobo < 0;
  const a = Math.abs(kobo);
  const naira = Math.floor(a / 100);
  const k = a % 100;
  let s = `${integerToWords(naira)} naira`;
  if (k > 0) s += `, ${integerToWords(k)} kobo`;
  s += " only";
  return capitalise(neg ? `minus ${s}` : s);
}
