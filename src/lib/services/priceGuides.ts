import { and, asc, desc, eq, gte, isNull, lte, or, sql, type SQL } from "drizzle-orm";

import type { DbOrTx, Tx } from "@/db/client";
import { buyingPoints, commodities, grades, priceGuides } from "@/db/schema";
import type { OrgContext } from "@/lib/authz/context";
import { writeAudit } from "@/lib/audit/audit";
import { DomainError } from "@/lib/domain/errors";
import type {
  PriceGuideInput,
  PriceGuideListInput,
  PriceGuideUpdateInput,
} from "@/lib/validation/buying";

import { assertWritable, inTx, notFound } from "./suppliers";

/**
 * Price guides (P2-A): the day's maximum buying price per kg, scoped to a
 * commodity and optionally a grade and/or buying point.
 *
 * Lookup rule (DATA-MODEL): most specific match wins —
 *   exact grade + point  >  grade + null point  >  null grade + point  >  both null
 * — and within that, the latest guide_date <= the purchase date.
 */

export type PriceGuide = typeof priceGuides.$inferSelect;

export type PriceGuideRow = PriceGuide & {
  commodityName: string;
  gradeName: string | null;
  buyingPointName: string | null;
};

/** Validate commodity/grade/buying point belong to the org (and grade to commodity). */
export async function assertGuideRefs(
  dbOrTx: DbOrTx,
  ctx: OrgContext,
  refs: { commodityId: string; gradeId: string | null; buyingPointId: string | null },
): Promise<void> {
  const [c] = await dbOrTx
    .select({ id: commodities.id })
    .from(commodities)
    .where(and(eq(commodities.organisationId, ctx.orgId), eq(commodities.id, refs.commodityId)))
    .limit(1);
  if (!c) notFound("Commodity");
  if (refs.gradeId) {
    const [g] = await dbOrTx
      .select({ id: grades.id, commodityId: grades.commodityId })
      .from(grades)
      .where(and(eq(grades.organisationId, ctx.orgId), eq(grades.id, refs.gradeId)))
      .limit(1);
    if (!g) notFound("Grade");
    if (g.commodityId !== refs.commodityId) {
      throw new DomainError("GRADE_COMMODITY_MISMATCH", "Grade does not belong to the commodity");
    }
  }
  if (refs.buyingPointId) {
    const [bp] = await dbOrTx
      .select({ id: buyingPoints.id })
      .from(buyingPoints)
      .where(and(eq(buyingPoints.organisationId, ctx.orgId), eq(buyingPoints.id, refs.buyingPointId)))
      .limit(1);
    if (!bp) notFound("Buying point");
  }
}

const nullableEq = <C extends typeof priceGuides.gradeId | typeof priceGuides.buyingPointId>(col: C, v: string | null) =>
  v === null ? isNull(col) : eq(col, v);

/** Postgres UNIQUE treats NULLs as distinct, so the scope uniqueness is checked here (inside the tx). */
async function assertScopeFree(
  tx: Tx,
  ctx: OrgContext,
  scope: { commodityId: string; gradeId: string | null; buyingPointId: string | null; guideDate: string },
  exceptId?: string,
): Promise<void> {
  const rows = await tx
    .select({ id: priceGuides.id })
    .from(priceGuides)
    .where(
      and(
        eq(priceGuides.organisationId, ctx.orgId),
        eq(priceGuides.commodityId, scope.commodityId),
        nullableEq(priceGuides.gradeId, scope.gradeId),
        nullableEq(priceGuides.buyingPointId, scope.buyingPointId),
        eq(priceGuides.guideDate, scope.guideDate),
      ),
    );
  if (rows.some((r) => r.id !== exceptId)) {
    throw new DomainError("DUPLICATE", "A price guide for that scope and date already exists");
  }
}

export async function createPriceGuide(dbOrTx: DbOrTx, ctx: OrgContext, input: PriceGuideInput): Promise<PriceGuide> {
  assertWritable(ctx);
  return inTx(dbOrTx, async (tx) => {
    await assertGuideRefs(tx, ctx, input);
    // Serialise creators of the same scope (null-safe uniqueness).
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`pg:${ctx.orgId}:${input.commodityId}:${input.gradeId}:${input.buyingPointId}:${input.guideDate}`}))`,
    );
    await assertScopeFree(tx, ctx, input);
    const [row] = await tx
      .insert(priceGuides)
      .values({
        organisationId: ctx.orgId,
        commodityId: input.commodityId,
        gradeId: input.gradeId,
        buyingPointId: input.buyingPointId,
        guideDate: input.guideDate,
        maxPricePerKgKobo: input.maxPricePerKgKobo,
        createdBy: ctx.userId,
      })
      .returning();
    await writeAudit(tx, ctx, { action: "create", tableName: "price_guides", recordId: row.id, after: row });
    return row;
  });
}

export async function updatePriceGuide(
  dbOrTx: DbOrTx,
  ctx: OrgContext,
  input: PriceGuideUpdateInput,
): Promise<PriceGuide> {
  assertWritable(ctx);
  return inTx(dbOrTx, async (tx) => {
    const [before] = await tx
      .select()
      .from(priceGuides)
      .where(and(eq(priceGuides.organisationId, ctx.orgId), eq(priceGuides.id, input.id)))
      .for("update");
    if (!before) notFound("Price guide");
    if (before.guideDate !== input.guideDate) {
      await assertScopeFree(tx, ctx, { ...before, guideDate: input.guideDate }, before.id);
    }
    const [after] = await tx
      .update(priceGuides)
      .set({ guideDate: input.guideDate, maxPricePerKgKobo: input.maxPricePerKgKobo, updatedAt: new Date() })
      .where(and(eq(priceGuides.organisationId, ctx.orgId), eq(priceGuides.id, input.id)))
      .returning();
    await writeAudit(tx, ctx, { action: "update", tableName: "price_guides", recordId: after.id, before, after });
    return after;
  });
}

export async function deletePriceGuide(dbOrTx: DbOrTx, ctx: OrgContext, id: string): Promise<void> {
  assertWritable(ctx);
  await inTx(dbOrTx, async (tx) => {
    const [before] = await tx
      .select()
      .from(priceGuides)
      .where(and(eq(priceGuides.organisationId, ctx.orgId), eq(priceGuides.id, id)))
      .for("update");
    if (!before) notFound("Price guide");
    await tx.delete(priceGuides).where(and(eq(priceGuides.organisationId, ctx.orgId), eq(priceGuides.id, id)));
    await writeAudit(tx, ctx, { action: "cancel", tableName: "price_guides", recordId: id, before });
  });
}

export async function getPriceGuide(dbOrTx: DbOrTx, ctx: OrgContext, id: string): Promise<PriceGuide> {
  const [row] = await dbOrTx
    .select()
    .from(priceGuides)
    .where(and(eq(priceGuides.organisationId, ctx.orgId), eq(priceGuides.id, id)))
    .limit(1);
  return row ?? notFound("Price guide");
}

export async function listPriceGuides(
  dbOrTx: DbOrTx,
  ctx: OrgContext,
  input: Partial<PriceGuideListInput> = {},
): Promise<{ rows: PriceGuideRow[]; total: number; page: number; pageSize: number }> {
  const page = input.page ?? 1;
  const pageSize = input.pageSize ?? 50;
  const where: SQL[] = [eq(priceGuides.organisationId, ctx.orgId)];
  if (input.commodityId) where.push(eq(priceGuides.commodityId, input.commodityId));
  if (input.buyingPointId) {
    where.push(or(eq(priceGuides.buyingPointId, input.buyingPointId), isNull(priceGuides.buyingPointId))!);
  }
  if (input.from) where.push(gte(priceGuides.guideDate, input.from));
  if (input.to) where.push(lte(priceGuides.guideDate, input.to));

  const [{ n }] = await dbOrTx
    .select({ n: sql<string>`count(*)` })
    .from(priceGuides)
    .where(and(...where));
  const rows = await dbOrTx
    .select({
      guide: priceGuides,
      commodityName: commodities.name,
      gradeName: grades.name,
      buyingPointName: buyingPoints.name,
    })
    .from(priceGuides)
    .innerJoin(commodities, eq(commodities.id, priceGuides.commodityId))
    .leftJoin(grades, eq(grades.id, priceGuides.gradeId))
    .leftJoin(buyingPoints, eq(buyingPoints.id, priceGuides.buyingPointId))
    .where(and(...where))
    .orderBy(desc(priceGuides.guideDate), asc(commodities.name), asc(priceGuides.id))
    .limit(pageSize)
    .offset((page - 1) * pageSize);
  return {
    rows: rows.map((r) => ({
      ...r.guide,
      commodityName: r.commodityName,
      gradeName: r.gradeName,
      buyingPointName: r.buyingPointName,
    })),
    total: Number(n),
    page,
    pageSize,
  };
}

/**
 * Most-specific applicable guide for a purchase line, or null when none
 * applies. `buyingPointId: null` matches only point-agnostic guides.
 */
export async function lookupGuide(
  dbOrTx: DbOrTx,
  ctx: OrgContext,
  input: { commodityId: string; gradeId: string | null; buyingPointId: string | null; date: string },
): Promise<PriceGuide | null> {
  const gradeCond = input.gradeId
    ? or(eq(priceGuides.gradeId, input.gradeId), isNull(priceGuides.gradeId))!
    : isNull(priceGuides.gradeId);
  const pointCond = input.buyingPointId
    ? or(eq(priceGuides.buyingPointId, input.buyingPointId), isNull(priceGuides.buyingPointId))!
    : isNull(priceGuides.buyingPointId);
  const [row] = await dbOrTx
    .select()
    .from(priceGuides)
    .where(
      and(
        eq(priceGuides.organisationId, ctx.orgId),
        eq(priceGuides.commodityId, input.commodityId),
        lte(priceGuides.guideDate, input.date),
        gradeCond,
        pointCond,
      ),
    )
    .orderBy(
      // specificity: grade (2) outranks point (1)
      desc(sql`(case when ${priceGuides.gradeId} is not null then 2 else 0 end) + (case when ${priceGuides.buyingPointId} is not null then 1 else 0 end)`),
      desc(priceGuides.guideDate),
      desc(priceGuides.createdAt),
    )
    .limit(1);
  return row ?? null;
}
