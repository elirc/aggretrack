/**
 * Fully-typed, JSON-safe props for every PDF template. Templates never touch
 * the DB: callers (worker jobs, statement services) assemble these.
 *
 * Units: money = integer kobo, weights = integer grams, dates = PdfDate
 * ("YYYY-MM-DD" calendar date or ISO timestamp; printed in Africa/Lagos).
 */
import type { PdfDate } from "./format";

export type { PdfDate };

export interface PdfOrg {
  name: string;
  address?: string | null;
  phone?: string | null;
  email?: string | null;
}

export interface PdfParty {
  name: string;
  phone?: string | null;
  /** Free-form address lines (village/LGA/state, street address …). Nulls are skipped. */
  addressLines?: (string | null | undefined)[];
}

// --- GRN -------------------------------------------------------------------

export interface GrnLine {
  commodity: string;
  grade: string;
  bags: number;
  grossGrams: number;
  deductionGrams: number;
  netGrams: number;
  pricePerKgKobo: number;
  amountKobo: number;
  lotNumber?: string | null;
}

export interface GrnProps {
  org: PdfOrg;
  grnNumber: string;
  purchaseNumber?: string | null;
  purchaseDate: PdfDate;
  receivedAt?: PdfDate | null;
  receivedWarehouse?: string | null;
  buyingPoint?: string | null;
  officer?: string | null;
  supplier: PdfParty;
  lines: GrnLine[];
  /** Authoritative purchase total (purchases.total_amount_kobo). */
  totalAmountKobo: number;
  /** Hide price/amount columns (warehouse copy). */
  hidePrices?: boolean;
  generatedAt?: PdfDate;
}

// --- Waybill ---------------------------------------------------------------

export interface WaybillLine {
  lotNumber: string;
  commodity: string;
  grade?: string | null;
  grams: number;
  /** null when bags aren't tracked on the dispatch line. */
  bags?: number | null;
}

export interface WaybillProps {
  org: PdfOrg;
  waybillNumber: string;
  dispatchedAt: PdfDate;
  salesOrderNumber?: string | null;
  customer: PdfParty;
  fromWarehouse?: string | null;
  vehicle?: { plateNumber: string; description?: string | null } | null;
  driver?: { name: string; phone?: string | null } | null;
  lines: WaybillLine[];
  /** dispatches.dispatched_kg in grams. */
  dispatchedGrams: number;
  deliveredGrams?: number | null;
  generatedAt?: PdfDate;
}

// --- Invoice ---------------------------------------------------------------

export type InvoiceStatus = "issued" | "part_paid" | "paid" | "void";

export interface InvoiceLine {
  description: string;
  grade?: string | null;
  grams: number;
  pricePerKgKobo: number;
  amountKobo: number;
}

export interface BankDetails {
  bankName: string;
  accountName: string;
  accountNumber: string;
}

export interface InvoiceProps {
  org: PdfOrg;
  invoiceNumber: string;
  invoiceDate: PdfDate;
  dueDate?: PdfDate | null;
  salesOrderNumber?: string | null;
  waybillNumber?: string | null;
  customer: PdfParty;
  lines: InvoiceLine[];
  subtotalKobo: number;
  /** numeric(5,2) string or number; tax line printed only when > 0. */
  taxPercent: string | number;
  taxKobo: number;
  totalKobo: number;
  paidKobo: number;
  status: InvoiceStatus;
  /** null/undefined → placeholder text. */
  bankDetails?: BankDetails | null;
  generatedAt?: PdfDate;
}

// --- Statements ------------------------------------------------------------

export type SupplierStatementRowKind = "purchase" | "payment" | "advance" | "offset";
export type CustomerStatementRowKind = "invoice" | "payment";

export interface StatementRow<K extends string = string> {
  date: PdfDate;
  kind: K;
  reference: string;
  description?: string | null;
  /**
   * Signed effect on the balance.
   * Supplier statement: + increases what the org owes the supplier (purchase),
   *   − decreases it (payment, advance). Offsets are usually 0-effect memo rows
   *   or whatever the assembling service decides.
   * Customer statement: + increases what the customer owes (invoice), − payment.
   */
  amountKobo: number;
}

export interface SupplierStatementProps {
  org: PdfOrg;
  supplier: PdfParty;
  periodFrom?: PdfDate | null;
  periodTo?: PdfDate | null;
  openingBalanceKobo?: number;
  rows: StatementRow<SupplierStatementRowKind>[];
  generatedAt?: PdfDate;
}

export interface CustomerStatementProps {
  org: PdfOrg;
  customer: PdfParty;
  periodFrom?: PdfDate | null;
  periodTo?: PdfDate | null;
  openingBalanceKobo?: number;
  rows: StatementRow<CustomerStatementRowKind>[];
  generatedAt?: PdfDate;
}

// --- Kind map --------------------------------------------------------------

export type PdfKind = "grn" | "waybill" | "invoice" | "supplier_statement" | "customer_statement";

export interface PdfPropsMap {
  grn: GrnProps;
  waybill: WaybillProps;
  invoice: InvoiceProps;
  supplier_statement: SupplierStatementProps;
  customer_statement: CustomerStatementProps;
}
