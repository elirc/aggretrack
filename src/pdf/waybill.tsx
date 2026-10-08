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
import { pdfDate, pdfDateTime, pdfKg } from "./format";
import type { WaybillLine, WaybillProps } from "./types";

/** Waybill — travels with the vehicle; consignee signs on delivery. */
export function WaybillDocument(props: WaybillProps) {
  const { Text, View } = rp();
  const lineGrams = props.lines.reduce((a, l) => a + l.grams, 0);
  const bagsKnown = props.lines.every((l) => l.bags != null);
  const totalBags = bagsKnown ? props.lines.reduce((a, l) => a + (l.bags ?? 0), 0) : null;

  const columns: Column<WaybillLine>[] = [
    { header: "Lot", width: 1.8, cell: (l) => l.lotNumber },
    {
      header: "Commodity / grade",
      width: 2.4,
      cell: (l) => (l.grade ? `${l.commodity} - ${l.grade}` : l.commodity),
    },
    { header: "Bags", width: 0.8, align: "right", cell: (l) => (l.bags == null ? "-" : String(l.bags)) },
    { header: "Kg", width: 1.4, align: "right", cell: (l) => pdfKg(l.grams) },
  ];

  const vehicle = props.vehicle
    ? `${props.vehicle.plateNumber}${props.vehicle.description ? ` (${props.vehicle.description})` : ""}`
    : null;
  const driver = props.driver
    ? `${props.driver.name}${props.driver.phone ? `, ${props.driver.phone}` : ""}`
    : null;

  return (
    <PdfShell
      title="WAYBILL"
      org={props.org}
      number={props.waybillNumber}
      date={pdfDate(props.dispatchedAt)}
      generatedAt={props.generatedAt}
    >
      <KeyValueGrid
        items={[
          { label: "Sales order", value: props.salesOrderNumber },
          { label: "Dispatched", value: pdfDateTime(props.dispatchedAt) },
          { label: "From", value: props.fromWarehouse },
          { label: "Vehicle", value: vehicle ?? "-" },
          { label: "Driver", value: driver ?? "-" },
        ]}
      />
      <View style={styles.sectionRow}>
        <PartyBlock label="Consignee" party={props.customer} />
      </View>
      <Table
        columns={columns}
        rows={props.lines}
        footer={["Totals", "", totalBags == null ? "-" : String(totalBags), pdfKg(lineGrams)]}
      />
      <Totals
        lines={[
          { label: "Dispatched kg", value: pdfKg(props.dispatchedGrams), strong: true },
          ...(totalBags == null ? [] : [{ label: "Bags", value: String(totalBags) }]),
          ...(props.deliveredGrams == null
            ? []
            : [
                { label: "Delivered kg", value: pdfKg(props.deliveredGrams) },
                { label: "Transit loss kg", value: pdfKg(props.dispatchedGrams - props.deliveredGrams) },
              ]),
        ]}
      />
      <Text style={[styles.note, styles.muted]}>
        Consignee: check weight and bag count on arrival and record any shortfall below before signing.
      </Text>
      <Text style={styles.note}>Received kg: ____________    Bags: ________    Remarks: ______________________</Text>
      <Signatures labels={["Dispatched by", "Driver", "Consignee"]} />
    </PdfShell>
  );
}
