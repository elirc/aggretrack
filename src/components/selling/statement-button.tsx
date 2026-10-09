"use client";

import { useParams } from "next/navigation";

import { StatementRangeButton } from "@/components/notifications/StatementRangeButton";
import { generateCustomerStatementAction } from "@/actions/statements";

/**
 * Customer statement button — period popover → PDF (P4-D). The customer page
 * renders it without props, so the id falls back to the /customers/[id] route param.
 */
export function StatementButton({ customerId }: { customerId?: string } = {}) {
  const params = useParams<{ id?: string }>();
  const id = customerId ?? (typeof params?.id === "string" ? params.id : undefined);
  if (!id) return null;
  return <StatementRangeButton id={id} action={generateCustomerStatementAction} />;
}
