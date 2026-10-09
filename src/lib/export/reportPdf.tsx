/**
 * Generic landscape-A4 table PDF for any ReportResult.
 *
 * Follows the src/pdf lazy-ESM pattern: only TYPES come from
 * @react-pdf/renderer statically; primitives come from rp() at render time
 * (renderReportPdf.ts awaits loadReactPdf() first).
 */
import type { AnyReportResult, ColumnType } from "@/lib/services/reports";
import { formatCell, isNumericType } from "@/components/reports/format";
import { OrgHeader, PdfFooter, Table, styles, type Column } from "@/pdf/components";
import type { PdfDate } from "@/pdf/format";
import { rp } from "@/pdf/runtime";
import type { PdfOrg } from "@/pdf/types";

export type ReportPdfProps = {
  org: PdfOrg;
  report: AnyReportResult;
  generatedAt?: PdfDate;
};

const FLEX: Record<ColumnType, number> = {
  text: 2.4,
  date: 1.1,
  datetime: 1.5,
  kg: 1.2,
  kobo: 1.5,
  rate: 1.2,
  percent: 0.9,
  int: 0.8,
};

type Row = Record<string, unknown>;

export function ReportPdfDocument({ org, report, generatedAt }: ReportPdfProps) {
  const { Document, Page, Text } = rp();
  const columns: Column<Row>[] = report.columns.map((c) => ({
    header: c.label,
    width: FLEX[c.type as ColumnType],
    align: isNumericType(c.type) ? "right" : "left",
    cell: (row) => formatCell(c.type, row[c.key], "pdf"),
  }));
  const totals = report.totals as Row | null;
  const footer = totals
    ? report.columns.map((c, i) => {
        const v = totals[c.key];
        if (v === undefined || v === null || v === "") return i === 0 ? "Total" : "";
        return formatCell(c.type, v, "pdf");
      })
    : undefined;

  return (
    <Document title={report.title} author={org.name} creator="AggreTrack" producer="AggreTrack">
      <Page size="A4" orientation="landscape" style={{ ...styles.page, fontSize: 7 }}>
        <OrgHeader org={org} title={report.title} date={report.subtitle} />
        <Table columns={columns} rows={report.rows as Row[]} footer={footer} emptyText="No data for these filters" />
        <Text style={styles.muted}>
          {report.rows.length} row{report.rows.length === 1 ? "" : "s"}
        </Text>
        <PdfFooter generatedAt={generatedAt} />
      </Page>
    </Document>
  );
}
