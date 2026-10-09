/**
 * renderReportPdf(props) → Buffer. Node only. Loads react-pdf lazily (see
 * src/pdf/runtime.ts) before building the element, so rp() is valid inside
 * ReportPdfDocument.
 */
import { createElement, type ReactElement } from "react";
import type { DocumentProps } from "@react-pdf/renderer";

import { loadReactPdf } from "@/pdf/runtime";

import { ReportPdfDocument, type ReportPdfProps } from "./reportPdf";

export async function renderReportPdf(props: ReportPdfProps): Promise<Buffer> {
  const { renderToBuffer } = await loadReactPdf();
  // Root is <Document>; the cast bridges react-pdf's element typing (as in src/pdf/render.ts).
  const el = createElement(ReportPdfDocument, props) as unknown as ReactElement<DocumentProps>;
  return renderToBuffer(el);
}
