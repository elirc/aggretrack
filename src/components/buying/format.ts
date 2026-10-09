import { formatNaira, gramsToKg, kgToGrams, type Grams, type Kobo } from "@/lib/domain/units";

/**
 * Client-safe display + input helpers for the buying UI. Money is integer kobo
 * everywhere; users type naira. Weights travel as kg decimal strings.
 */

/** "₦12,345.67", or an em dash when the value is hidden/absent. */
export function naira(kobo: Kobo | null | undefined): string {
  if (kobo === null || kobo === undefined) return "—";
  return formatNaira(kobo);
}

/** Per-kg price label: "₦350.00/kg". */
export function nairaPerKg(kobo: Kobo | null | undefined): string {
  if (kobo === null || kobo === undefined) return "—";
  return `${formatNaira(kobo)}/kg`;
}

/**
 * Parse a typed naira amount ("1,234.5", "₦ 350") into integer kobo.
 * Returns null when it is not a valid non-negative amount with ≤ 2 decimals.
 */
export function parseNairaToKobo(raw: string | null | undefined): Kobo | null {
  if (raw === null || raw === undefined) return null;
  const s = raw.replace(/[₦,\s]/g, "");
  const m = /^(\d{1,13})(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return null;
  const kobo = Number.parseInt(m[1], 10) * 100 + Number.parseInt((m[2] ?? "").padEnd(2, "0") || "0", 10);
  return Number.isSafeInteger(kobo) ? kobo : null;
}

/** Integer kobo → naira input text ("350" or "350.50"). */
export function koboToNairaInput(kobo: Kobo | null | undefined): string {
  if (kobo === null || kobo === undefined) return "";
  const whole = Math.trunc(kobo / 100);
  const frac = kobo % 100;
  return frac === 0 ? String(whole) : `${whole}.${String(frac).padStart(2, "0")}`;
}

const KG_RE = /^\d{1,9}(\.\d{1,3})?$/;

/** Typed kg → integer grams, or null when invalid/blank. */
export function parseKgToGrams(raw: string | null | undefined): Grams | null {
  if (raw === null || raw === undefined) return null;
  const s = raw.trim();
  if (!KG_RE.test(s)) return null;
  return kgToGrams(s);
}

function group(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** "1234.500" → "1,234.5 kg"; trims trailing zeros. */
export function displayKg(kg: string | null | undefined): string {
  if (kg === null || kg === undefined || kg === "") return "—";
  const neg = kg.startsWith("-");
  const body = neg ? kg.slice(1) : kg;
  const [whole, frac = ""] = body.split(".");
  const f = frac.replace(/0+$/, "");
  return `${neg ? "-" : ""}${group(whole)}${f ? `.${f}` : ""} kg`;
}

/** Integer grams → display kg. */
export function displayGrams(g: Grams): string {
  return displayKg(gramsToKg(g));
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-10-08" → "08 Oct 2026" (calendar dates are not timezone-shifted). */
export function displayDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  return `${m[3]} ${MONTHS[Number(m[2]) - 1] ?? m[2]} ${m[1]}`;
}

/** "2026-10" → "Oct 2026". */
export function displayPeriod(period: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(period);
  if (!m) return period;
  return `${MONTHS[Number(m[2]) - 1] ?? m[2]} ${m[1]}`;
}

/** Timestamp → "08 Oct 2026, 14:05" in Africa/Lagos. */
export function displayDateTime(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const date = typeof d === "string" ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Lagos",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
}

/** Today's calendar date in Africa/Lagos, "yyyy-mm-dd". */
export function lagosTodayISO(at: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Lagos",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

/**
 * RFC 4122 v4 UUID. crypto.randomUUID only exists in secure contexts (https /
 * localhost); phones on a LAN IP over http fall back to getRandomValues.
 */
export function newUuid(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  const b = new Uint8Array(16);
  if (c && typeof c.getRandomValues === "function") c.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export const SUPPLIER_TYPE_LABELS = {
  farmer: "Farmer",
  agent: "Agent",
  cooperative: "Cooperative",
} as const;

export const DEDUCTION_REASON_LABELS = {
  moisture: "Moisture",
  foreign_matter: "Foreign matter",
  sack_weight: "Sack weight",
  other: "Other",
} as const;

export const PAYMENT_METHOD_LABELS = {
  cash: "Cash",
  transfer: "Transfer",
  pos: "POS",
} as const;
