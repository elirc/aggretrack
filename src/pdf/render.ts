/**
 * renderPdf(kind, props) → Buffer. Node only (not edge).
 * Import-light on purpose: no DB, no adapters — safe for unit tests and the worker.
 * Relative imports so the worker (tsx) can load this without the `@/*` alias.
 * react-pdf itself is loaded lazily (runtime.ts) so this module also loads
 * under tsx's CommonJS mode.
 */
import { createElement, type ComponentType, type ReactElement } from "react";
import type { DocumentProps } from "@react-pdf/renderer";

import type { DocumentKind } from "../lib/jobs";
import { CustomerStatementDocument } from "./customer-statement";
import { GrnDocument } from "./grn";
import { InvoiceDocument } from "./invoice";
import { loadReactPdf } from "./runtime";
import { SupplierStatementDocument } from "./supplier-statement";
import type { PdfKind, PdfPropsMap } from "./types";
import { WaybillDocument } from "./waybill";

export type * from "./types";

// Compile-time guard: the PDF kinds and the queue's DocumentKind stay in sync.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const _kindsInSync: Same<PdfKind, DocumentKind> = true;
void _kindsInSync;

const TEMPLATES: { [K in PdfKind]: ComponentType<PdfPropsMap[K]> } = {
  grn: GrnDocument,
  waybill: WaybillDocument,
  invoice: InvoiceDocument,
  supplier_statement: SupplierStatementDocument,
  customer_statement: CustomerStatementDocument,
};

export const PDF_KINDS = Object.keys(TEMPLATES) as PdfKind[];

export function isPdfKind(kind: string): kind is PdfKind {
  return Object.prototype.hasOwnProperty.call(TEMPLATES, kind);
}

/** Build the react-pdf element for a kind (exposed for streaming callers). */
export function pdfElement<K extends PdfKind>(kind: K, props: PdfPropsMap[K]): ReactElement<DocumentProps> {
  const Component = TEMPLATES[kind] as ComponentType<PdfPropsMap[K]>;
  // Every template's root is <Document>; the cast bridges react-pdf's element typing.
  return createElement(Component, props) as unknown as ReactElement<DocumentProps>;
}

export async function renderPdf<K extends PdfKind>(kind: K, props: PdfPropsMap[K]): Promise<Buffer> {
  const { renderToBuffer } = await loadReactPdf();
  return renderToBuffer(pdfElement(kind, props));
}

/** Streaming variant for route handlers (Node runtime only). */
export async function renderPdfStream<K extends PdfKind>(
  kind: K,
  props: PdfPropsMap[K],
): Promise<NodeJS.ReadableStream> {
  const { renderToStream } = await loadReactPdf();
  return renderToStream(pdfElement(kind, props));
}
