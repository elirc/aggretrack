import { rp } from "./runtime";

import { KeyValueGrid, PartyBlock, PdfShell, StatementTable, styles } from "./components";
import { pdfDate, pdfNaira } from "./format";
import type { SupplierStatementProps, SupplierStatementRowKind } from "./types";

const KIND_LABELS: Record<SupplierStatementRowKind, string> = {
  purchase: "Purchase",
  payment: "Payment",
  advance: "Advance",
  offset: "Advance offset",
};

/** Positive = org owes supplier; negative = supplier owes org (unrecovered advances). */
function balanceLabel(kobo: number): string {
  if (kobo === 0) return pdfNaira(0);
  return kobo > 0 ? `${pdfNaira(kobo)} CR` : `${pdfNaira(-kobo)} DR`;
}

function closingLabel(kobo: number): string {
  if (kobo === 0) return "Account settled - nothing owed either way.";
  return kobo > 0
    ? `Balance owed to supplier: ${pdfNaira(kobo)}`
    : `Balance owed by supplier (advances outstanding): ${pdfNaira(-kobo)}`;
}

export function SupplierStatementDocument(props: SupplierStatementProps) {
  const { View } = rp();
  const period =
    props.periodFrom || props.periodTo
      ? `${pdfDate(props.periodFrom)} to ${pdfDate(props.periodTo ?? props.generatedAt)}`
      : null;
  return (
    <PdfShell
      title="SUPPLIER STATEMENT"
      org={props.org}
      date={pdfDate(props.generatedAt ?? new Date().toISOString())}
      generatedAt={props.generatedAt}
    >
      <View style={styles.sectionRow}>
        <PartyBlock label="Supplier" party={props.supplier} />
      </View>
      <KeyValueGrid items={[{ label: "Period", value: period }]} />
      <StatementTable
        rows={props.rows}
        openingBalanceKobo={props.openingBalanceKobo}
        kindLabels={KIND_LABELS}
        balanceLabel={balanceLabel}
        closingLabel={closingLabel}
      />
    </PdfShell>
  );
}
