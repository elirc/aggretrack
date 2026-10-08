import { rp } from "./runtime";

import { KeyValueGrid, PartyBlock, PdfShell, Table, Totals, styles, type Column, type TotalLine } from "./components";
import { amountInWords, pdfDate, pdfKg, pdfNaira } from "./format";
import type { InvoiceLine, InvoiceProps, InvoiceStatus } from "./types";

const STATUS_LABEL: Record<InvoiceStatus, string> = {
  issued: "UNPAID",
  part_paid: "PART PAID",
  paid: "PAID",
  void: "VOID",
};

function taxPercentNumber(p: string | number): number {
  const n = typeof p === "number" ? p : Number(p);
  return Number.isFinite(n) ? n : 0;
}

export function InvoiceDocument(props: InvoiceProps) {
  const { Text, View } = rp();
  const taxPct = taxPercentNumber(props.taxPercent);
  const balance = props.totalKobo - props.paidKobo;

  const columns: Column<InvoiceLine>[] = [
    {
      header: "Description",
      width: 2.8,
      cell: (l) => (l.grade ? `${l.description} - ${l.grade}` : l.description),
    },
    { header: "Kg", width: 1.3, align: "right", cell: (l) => pdfKg(l.grams) },
    { header: "Price/kg", width: 1.3, align: "right", cell: (l) => pdfNaira(l.pricePerKgKobo) },
    { header: "Amount", width: 1.7, align: "right", cell: (l) => pdfNaira(l.amountKobo) },
  ];

  const totals: TotalLine[] = [{ label: "Subtotal", value: pdfNaira(props.subtotalKobo) }];
  if (taxPct > 0) {
    totals.push({ label: `Tax (${taxPct}%)`, value: pdfNaira(props.taxKobo) });
  }
  totals.push({ label: "Total", value: pdfNaira(props.totalKobo), strong: true });
  if (props.paidKobo > 0) {
    totals.push({ label: "Paid", value: pdfNaira(props.paidKobo) });
    totals.push({ label: "Balance due", value: pdfNaira(balance), strong: true });
  }

  const bank = props.bankDetails;

  return (
    <PdfShell
      title="INVOICE"
      org={props.org}
      number={props.invoiceNumber}
      date={pdfDate(props.invoiceDate)}
      generatedAt={props.generatedAt}
    >
      <KeyValueGrid
        items={[
          { label: "Invoice date", value: pdfDate(props.invoiceDate) },
          { label: "Due date", value: props.dueDate ? pdfDate(props.dueDate) : null },
          { label: "Sales order", value: props.salesOrderNumber },
          { label: "Waybill", value: props.waybillNumber },
        ]}
      />
      <View style={styles.sectionRow}>
        <PartyBlock label="Bill to" party={props.customer} />
      </View>
      <Table columns={columns} rows={props.lines} />
      <Totals lines={totals} />
      <Text style={styles.note}>
        <Text style={styles.bold}>Amount in words: </Text>
        {amountInWords(props.totalKobo)}
      </Text>
      <View style={[styles.party, { marginBottom: 8 }]}>
        <Text style={styles.label}>Payment details</Text>
        {bank ? (
          <>
            <Text>Bank: {bank.bankName}</Text>
            <Text>Account name: {bank.accountName}</Text>
            <Text>Account number: {bank.accountNumber}</Text>
          </>
        ) : (
          <Text style={styles.muted}>Bank details: please contact us for payment instructions.</Text>
        )}
        <Text style={styles.muted}>Quote the invoice number {props.invoiceNumber} as payment reference.</Text>
      </View>
      <Text style={[styles.bold, { textAlign: "center", fontSize: 9 }]}>
        Status: {STATUS_LABEL[props.status]}
        {props.status === "part_paid" ? ` - balance ${pdfNaira(balance)}` : ""}
      </Text>
    </PdfShell>
  );
}
