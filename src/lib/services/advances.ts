import { and, desc, eq, sql, type SQL } from "drizzle-orm";

import type { DbOrTx } from "@/db/client";
import { supplierAdvances, suppliers } from "@/db/schema";
import type { OrgContext } from "@/lib/authz/context";
import { writeAudit } from "@/lib/audit/audit";
import { nextDocNumber } from "@/lib/services/numbering";
import type { AdvanceInput, AdvanceListInput } from "@/lib/validation/buying";

import { listAdvanceBalances, type AdvanceBalance } from "./payables";
import { assertWritable, getSupplierRow, inTx, notFound } from "./suppliers";

/**
 * Supplier advances (P2-A). An advance is money paid to a supplier before
 * delivery; it is recovered by offsetting it against received purchases
 * (supplierPayments.offsetAdvance). Outstanding = amount − Σ offsets (derived).
 */

export type SupplierAdvance = typeof supplierAdvances.$inferSelect;

export async function createAdvance(dbOrTx: DbOrTx, ctx: OrgContext, input: AdvanceInput): Promise<SupplierAdvance> {
  assertWritable(ctx);
  return inTx(dbOrTx, async (tx) => {
    await getSupplierRow(tx, ctx, input.supplierId);
    const advanceNumber = await nextDocNumber(tx, ctx.orgId, "adv");
    const [row] = await tx
      .insert(supplierAdvances)
      .values({
        organisationId: ctx.orgId,
        supplierId: input.supplierId,
        advanceNumber,
        amountKobo: input.amountKobo,
        advanceDate: input.advanceDate,
        note: input.note,
        createdBy: ctx.userId,
      })
      .returning();
    await writeAudit(tx, ctx, { action: "create", tableName: "supplier_advances", recordId: row.id, after: row });
    return row;
  });
}

export type AdvanceListRow = AdvanceBalance & { supplierName: string };

/** Advances with outstanding, newest first. */
export async function listAdvances(
  dbOrTx: DbOrTx,
  ctx: OrgContext,
  input: Partial<AdvanceListInput> = {},
): Promise<{ rows: AdvanceListRow[]; total: number; page: number; pageSize: number }> {
  const page = input.page ?? 1;
  const pageSize = input.pageSize ?? 50;
  const where: SQL[] = [eq(supplierAdvances.organisationId, ctx.orgId)];
  if (input.supplierId) where.push(eq(supplierAdvances.supplierId, input.supplierId));
  if (input.outstandingOnly) {
    where.push(
      sql`${supplierAdvances.amountKobo} > coalesce((select sum(sao.amount_kobo) from supplier_advance_offsets sao where sao.advance_id = "supplier_advances"."id"), 0)`,
    );
  }
  const [{ n }] = await dbOrTx
    .select({ n: sql<string>`count(*)` })
    .from(supplierAdvances)
    .where(and(...where));
  const page_ = await dbOrTx
    .select({ id: supplierAdvances.id, supplierName: suppliers.name })
    .from(supplierAdvances)
    .innerJoin(suppliers, eq(suppliers.id, supplierAdvances.supplierId))
    .where(and(...where))
    .orderBy(desc(supplierAdvances.advanceDate), desc(supplierAdvances.advanceNumber))
    .limit(pageSize)
    .offset((page - 1) * pageSize);
  const balances = await listAdvanceBalances(dbOrTx, ctx, { advanceIds: page_.map((r) => r.id) });
  const byId = new Map(balances.map((b) => [b.id, b]));
  return {
    rows: page_.flatMap((r) => {
      const b = byId.get(r.id);
      return b ? [{ ...b, supplierName: r.supplierName }] : [];
    }),
    total: Number(n),
    page,
    pageSize,
  };
}

/** All of one supplier's advances with outstanding, oldest first. */
export async function getAdvancesForSupplier(
  dbOrTx: DbOrTx,
  ctx: OrgContext,
  supplierId: string,
  opts: { outstandingOnly?: boolean } = {},
): Promise<AdvanceBalance[]> {
  await getSupplierRow(dbOrTx, ctx, supplierId);
  return listAdvanceBalances(dbOrTx, ctx, { supplierId, outstandingOnly: opts.outstandingOnly });
}

export async function getAdvance(dbOrTx: DbOrTx, ctx: OrgContext, id: string): Promise<AdvanceBalance> {
  const [row] = await listAdvanceBalances(dbOrTx, ctx, { advanceIds: [id] });
  return row ?? notFound("Advance");
}
