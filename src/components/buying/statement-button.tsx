"use client";

import { StatementRangeButton } from "@/components/notifications/StatementRangeButton";
import { generateSupplierStatementAction } from "@/actions/statements";

/** Supplier statement button — period popover → PDF (P4-D, src/actions/statements.ts). */
export function SupplierStatementButton({ supplierId }: { supplierId: string }) {
  return <StatementRangeButton id={supplierId} action={generateSupplierStatementAction} />;
}
