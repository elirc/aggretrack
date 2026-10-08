import { sql } from "drizzle-orm";

import {
  formatDocNumber,
  PREFIX_MAP,
  type DocType,
} from "@/lib/domain/numbering";
import type { Tx } from "@/db/client";

/** Calendar year in Africa/Lagos — document numbers follow the business year. */
export function lagosYear(at: Date = new Date()): number {
  return Number.parseInt(
    new Intl.DateTimeFormat("en", { timeZone: "Africa/Lagos", year: "numeric" }).format(at),
    10,
  );
}

/**
 * Gapless per-org/type/year document number (DATA-MODEL document_counters).
 *
 * MUST be called inside the same transaction that creates the row consuming the
 * number — a rollback releases the number, which is what keeps the sequence
 * gapless. The upsert takes a row lock on the counter, serialising concurrent
 * allocators for the same (org, type, year).
 */
export async function nextDocNumber(
  tx: Tx,
  orgId: string,
  type: DocType,
  year: number = lagosYear(),
): Promise<string> {
  const result = await tx.execute(sql`
    INSERT INTO document_counters (organisation_id, doc_type, year, last_number)
    VALUES (${orgId}, ${type}, ${year}, 1)
    ON CONFLICT (organisation_id, doc_type, year)
    DO UPDATE SET last_number = document_counters.last_number + 1
    RETURNING last_number
  `);
  const rows = (result as unknown as { rows?: Array<{ last_number: number | string }> }).rows ??
    (result as unknown as Array<{ last_number: number | string }>);
  const row = Array.isArray(rows) ? rows[0] : undefined;
  if (!row) {
    throw new Error(`nextDocNumber: counter upsert returned no row (org=${orgId}, type=${type})`);
  }
  const seq = Number(row.last_number);
  return formatDocNumber(PREFIX_MAP[type], year, seq);
}
