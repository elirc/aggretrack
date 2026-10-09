/**
 * Pure display helpers for the warehouse UI (client- and server-safe).
 * Weights arrive as kg strings or integer grams; money as integer kobo.
 * Price/value fields may be ABSENT (hidePrices) — callers check for undefined.
 */
import { formatLagosDate, formatLagosDateTime } from "@/lib/domain/format";
import { formatNaira, gramsToKg, kgToGrams, roundHalfUpKobo, type Grams } from "@/lib/domain/units";

export { formatLagosDate, formatLagosDateTime };

function group(int: string): string {
  return int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** 1234500 g → "1,234.5 kg"; trailing zeros trimmed. */
export function fmtGrams(grams: Grams, unit = true): string {
  const s = gramsToKg(grams);
  const neg = s.startsWith("-");
  const body = neg ? s.slice(1) : s;
  const [int, frac = ""] = body.split(".");
  const f = frac.replace(/0+$/, "");
  const out = `${neg ? "-" : ""}${group(int)}${f ? `.${f}` : ""}`;
  return unit ? `${out} kg` : out;
}

/** "1234.500" → "1,234.5 kg"; null/blank → "—". */
export function fmtKg(kg: string | null | undefined, unit = true): string {
  if (kg === null || kg === undefined || kg.trim() === "") return "—";
  try {
    return fmtGrams(kgToGrams(kg), unit);
  } catch {
    return "—";
  }
}

/** "100.500" → "100.5", "100.000" → "100" for form defaults (no grouping). */
export function kgInput(kg: string): string {
  if (!kg.includes(".")) return kg;
  return kg.replace(/0+$/, "").replace(/\.$/, "");
}

/** Signed with explicit "+" for positives. */
export function fmtSignedGrams(grams: Grams): string {
  if (grams > 0) return `+${fmtGrams(grams)}`;
  if (grams < 0) return `−${fmtGrams(-grams)}`;
  return fmtGrams(0);
}

/** Safe kg-string → grams for live form maths (NaN-free; invalid → null). */
export function tryGrams(kg: string | null | undefined): Grams | null {
  if (kg === null || kg === undefined) return null;
  const s = kg.trim();
  if (!/^\d{1,9}(\.\d{1,3})?$/.test(s)) return null;
  return kgToGrams(s);
}

export function fmtNaira(kobo: number | null | undefined): string {
  if (kobo === null || kobo === undefined) return "—";
  return formatNaira(Math.round(kobo));
}

/** Landed rate (kobo per kg, possibly fractional) → "₦123.45/kg". */
export function fmtRatePerKg(rate: number | string | null | undefined): string {
  if (rate === null || rate === undefined || rate === "") return "—";
  const n = typeof rate === "number" ? rate : Number(rate);
  if (!Number.isFinite(n)) return "—";
  return `${formatNaira(roundHalfUpKobo(n))}/kg`;
}

export function fmtBags(bags: number | null | undefined): string {
  if (bags === null || bags === undefined) return "—";
  return `${bags.toLocaleString("en-NG")} bag${Math.abs(bags) === 1 ? "" : "s"}`;
}

export const MOVEMENT_TYPE_LABEL: Record<string, string> = {
  receive: "Receive",
  transfer_out: "Transfer out",
  transfer_in: "Transfer in",
  adjustment: "Adjustment",
  dispatch: "Dispatch",
  return: "Return",
};

export const ADJUSTMENT_REASON_LABEL: Record<string, string> = {
  shrinkage: "Shrinkage",
  spoilage: "Spoilage",
  theft: "Theft",
  re_bagging: "Re-bagging",
  count_difference: "Count difference",
};

const REF_LABEL: Record<string, string> = {
  grn: "GRN",
  trf: "Transfer",
  adj: "Adjustment",
  wb: "Waybill",
  cnt: "Count",
  so: "Sale",
};

/** Reference document → label + link (null href when there is no page). */
export function refDoc(
  refType: string | null | undefined,
  refId: string | null | undefined,
): { label: string; href: string | null } | null {
  if (!refType) return null;
  const label = REF_LABEL[refType] ?? refType.toUpperCase();
  if (!refId) return { label, href: null };
  switch (refType) {
    case "grn":
      return { label, href: `/purchases/${refId}` };
    case "trf":
      return { label, href: `/transfers/${refId}` };
    case "adj":
      return { label, href: `/adjustments/${refId}` };
    case "wb":
      return { label, href: `/dispatches/${refId}` };
    case "cnt":
      return { label, href: `/counts/${refId}` };
    default:
      return { label, href: null };
  }
}

export function shortId(id: string): string {
  return id.slice(0, 8);
}

/** Map an ActionResult error code to a person-readable message. */
export function warehouseErrorMessage(code: string): string {
  switch (code) {
    case "INSUFFICIENT_STOCK":
      return "Not enough stock for that — someone may have moved it. Refresh and try again.";
    case "INVALID_STATE":
      return "This record has already moved on. Refresh to see its current state.";
    case "RECEIVED_EXCEEDS_SENT":
      return "Received can't be more than was sent.";
    case "SAME_WAREHOUSE":
      return "Source and destination must differ.";
    case "DUPLICATE_LINE":
      return "Each lot can appear only once.";
    case "MISSING_LINES":
      return "Enter a received weight for every line.";
    case "INVALID_INPUT":
      return "Please check the values entered.";
    case "NOT_FOUND":
      return "That record no longer exists. Refresh and try again.";
    case "FORBIDDEN":
      return "You don't have permission to do that.";
    case "READ_ONLY":
      return "Subscription inactive — your organisation is read only.";
    case "VALIDATION":
      return "Please check the highlighted fields.";
    case "UNAUTHENTICATED":
      return "Your session has expired. Please sign in again.";
    default:
      return "Something went wrong. Please try again.";
  }
}
