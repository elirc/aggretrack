import { rp } from "./runtime";

import {
  KeyValueGrid,
  PartyBlock,
  PdfShell,
  Signatures,
  Table,
  Totals,
  styles,
  type Column,
} from "./components";
import { pdfDate, pdfDateTime, pdfKg, pdfNaira } from "./format";
import type { GrnLine, GrnProps } from "./types";

/** Goods Received Note — issued when a purchase is received into a warehouse. */
export function GrnDocument(props: GrnProps) {
  const { Text, View } = rp();
  const showPrices = !props.hidePrices;
  const sum = (f: (l: GrnLine) => number) => props.lines.reduce((a, l) => a + f(l), 0);
  const totalBags = sum((l) => l.bags);
  const totalGross = sum((l) => l.grossGrams);
  const totalDeductions = sum((l) => l.deductionGrams);
  const totalNet = sum((l) => l.netGrams);

  const columns: Column<GrnLine>[] = [
    { header: "Commodity / grade", width: 2.2, cell: (l) => `${l.commodity} - ${l.grade}` },
    { header: "Lot", width: 1.6, cell: (l) => l.lotNumber ?? "-" },
    { header: "Bags", width: 0.7, align: "right", cell: (l) => String(l.bags) },
    { header: "Gross kg", width: 1.3, align: "right", cell: (l) => pdfKg(l.grossGrams) },
    { header: "Ded. kg", width: 1.1, align: "right", cell: (l) => pdfKg(l.deductionGrams) },
    { header: "Net kg", width: 1.3, align: "right", cell: (l) => pdfKg(l.netGrams) },
  ];
  if (showPrices) {
    columns.push(
      { header: "Price/kg", width: 1.3, align: "right", cell: (l) => pdfNaira(l.pricePerKgKobo) },
      { header: "Amount", width: 1.7, align: "right", cell: (l) => pdfNaira(l.amountKobo) },
    );
  }
  const footer = [
    "Totals",
    "",
    String(totalBags),
    pdfKg(totalGross),
    pdfKg(totalDeductions),
    pdfKg(totalNet),
    ...(showPrices ? ["", pdfNaira(props.totalAmountKobo)] : []),
  ];

  return (
    <PdfShell
      title="GOODS RECEIVED NOTE"
      org={props.org}
      number={props.grnNumber}
      date={pdfDate(props.receivedAt ?? props.purchaseDate)}
      generatedAt={props.generatedAt}
    >
      <KeyValueGrid
        items={[
          { label: "Purchase no.", value: props.purchaseNumber },
          { label: "Purchase date", value: pdfDate(props.purchaseDate) },
          { label: "Received", value: props.receivedAt ? pdfDateTime(props.receivedAt) : null },
          { label: "Warehouse", value: props.receivedWarehouse },
          { label: "Buying point", value: props.buyingPoint },
          { label: "Officer", value: props.officer },
        ]}
      />
      <View style={styles.sectionRow}>
        <PartyBlock label="Supplier" party={props.supplier} />
      </View>
      <Table columns={columns} rows={props.lines} footer={footer} />
      <Totals
        lines={[
          { label: "Total bags", value: String(totalBags) },
          { label: "Total net kg", value: pdfKg(totalNet) },
          ...(showPrices
            ? [{ label: "Total amount", value: pdfNaira(props.totalAmountKobo), strong: true }]
            : []),
        ]}
      />
      <Text style={[styles.note, styles.muted]}>
        Net kg = gross kg less quality deductions (moisture, foreign matter, sack weight).
      </Text>
      <Signatures labels={["Supplier", "Receiving officer", "Store keeper"]} />
    </PdfShell>
  );
}
