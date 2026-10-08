/**
 * Document numbering (DOMAIN-ENGINE §12, DATA-MODEL document_counters, DECISIONS #4/#12).
 * Doc types are the lowercase pgEnum values; prefixes are their uppercase forms.
 */

export type DocType =
  | "po"
  | "grn"
  | "lot"
  | "trf"
  | "wb"
  | "so"
  | "inv"
  | "adj"
  | "cnt"
  | "adv"
  | "spm"
  | "cpm"
  | "trp"
  | "exp";

export const PREFIX_MAP: Record<DocType, string> = {
  po: "PO",
  grn: "GRN",
  lot: "LOT",
  trf: "TRF",
  wb: "WB",
  so: "SO",
  inv: "INV",
  adj: "ADJ",
  cnt: "CNT",
  adv: "ADV",
  spm: "SPM",
  cpm: "CPM",
  trp: "TRP",
  exp: "EXP",
};

export const ALL_DOC_TYPES = Object.keys(PREFIX_MAP) as DocType[];

/** "GRN-2026-00001" — pads to 5 digits, grows naturally past 99999. */
export function formatDocNumber(prefix: string, year: number, seq: number): string {
  if (!Number.isInteger(seq) || seq < 1) {
    throw new Error(`formatDocNumber: invalid sequence ${seq}`);
  }
  if (!Number.isInteger(year) || year < 2000 || year > 9999) {
    throw new Error(`formatDocNumber: invalid year ${year}`);
  }
  return `${prefix}-${year}-${String(seq).padStart(5, "0")}`;
}
