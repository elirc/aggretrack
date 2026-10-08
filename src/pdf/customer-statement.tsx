import { rp } from "./runtime";

import { KeyValueGrid, PartyBlock, PdfShell, StatementTable, styles } from "./components";
import { pdfDate, pdfNaira } from "./format";
import type { CustomerStatementProps, CustomerStatementRowKind } from "./types";

const KIND_LABELS: Record<CustomerStatementRowKind, string> = {
  invoice: "Invoice",
  payment: "Payment",
};

/** Positive = customer owes org; negative = customer in credit. */
function balanceLabel(kobo: number): string {
  if (kobo === 0) return pdfNaira(0);
  return kobo > 0 ? `${pdfNaira(kobo)} DR` : `${pdfNaira(-kobo)} CR`;
}

function closingLabel(kobo: number): string {
  if (kobo === 0) return "Account settled - nothing outstanding.";
  return kobo > 0
    ? `Amount due from customer: ${pdfNaira(kobo)}`
    : `Customer credit balance: ${pdfNaira(-kobo)}`;
}

export function CustomerStatementDocument(props: CustomerStatementProps) {
  const { View } = rp();
  const period =
    props.periodFrom || props.periodTo
      ? `${pdfDate(props.periodFrom)} to ${pdfDate(props.periodTo ?? props.generatedAt)}`
      : null;
  return (
    <PdfShell
      title="CUSTOMER STATEMENT"
      org={props.org}
      date={pdfDate(props.generatedAt ?? new Date().toISOString())}
      generatedAt={props.generatedAt}
    >
      <View style={styles.sectionRow}>
        <PartyBlock label="Customer" party={props.customer} />
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
