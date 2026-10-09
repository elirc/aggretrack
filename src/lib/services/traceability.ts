import { and, asc, eq, inArray } from "drizzle-orm";

import type { DbOrTx } from "@/db/client";
import {
  bins,
  commodities,
  customers,
  dispatchLines,
  dispatches,
  grades,
  lotAllocations,
  lots,
  purchaseLines,
  purchases,
  salesLines,
  salesOrders,
  stockMovements,
  suppliers,
  warehouses,
} from "@/db/schema";
import type { OrgContext } from "@/lib/authz/context";
import { DomainError } from "@/lib/domain/errors";
import { gramsToKg, kgToGrams, type Grams } from "@/lib/domain/units";

/**
 * Traceability (SPEC "Traceability and margin").
 * lotTrace: lot → supplier, purchase/line, every movement, every customer it went to.
 * saleTrace: sale → lines → allocations → lots → suppliers (with kg each).
 * Price fields are nulled when ctx.restrictions.hidePrices.
 */

export type LotTrace = {
  lot: {
    id: string;
    lotNumber: string;
    commodityId: string;
    commodityName: string;
    gradeId: string;
    gradeName: string;
    receivedAt: Date;
    originalKg: string;
    originalBags: number;
    onHandKg: string;
    purchasePricePerKgKobo: number | null;
    landedCostPerKgKobo: string | null;
  };
  supplier: { id: string; name: string; phone: string | null; village: string | null; type: string };
  purchase: {
    id: string;
    purchaseNumber: string | null;
    purchaseDate: string;
    grnNumber: string | null;
    status: string;
  };
  purchaseLine: {
    id: string;
    bags: number;
    grossKg: string;
    netKg: string;
    moisturePercent: string | null;
    pricePerKgKobo: number | null;
    amountKobo: number | null;
  };
  movements: {
    id: string;
    occurredAt: Date;
    type: string;
    warehouseId: string;
    warehouseName: string;
    binName: string | null;
    kg: string;
    bags: number;
    refType: string | null;
    refId: string | null;
  }[];
  dispatches: {
    dispatchLineId: string;
    dispatchId: string;
    waybillNumber: string | null;
    dispatchedAt: Date;
    kg: string;
    salesOrderId: string;
    orderNumber: string;
    customerId: string;
    customerName: string;
  }[];
  customers: { customerId: string; customerName: string; kg: string }[];
};

export type SaleTrace = {
  order: {
    id: string;
    orderNumber: string;
    orderDate: string;
    status: string;
    customerId: string;
    customerName: string;
  };
  lines: {
    salesLineId: string;
    commodityName: string;
    gradeName: string;
    kg: string;
    pricePerKgKobo: number | null;
    allocations: {
      allocationId: string;
      status: string;
      allocatedKg: string;
      dispatchedKg: string;
      lotId: string;
      lotNumber: string;
      warehouseName: string;
      supplierId: string;
      supplierName: string;
      purchaseId: string;
      purchaseNumber: string | null;
      purchaseDate: string;
    }[];
  }[];
  /** One row per supplier: kg allocated (non-cancelled) and kg actually dispatched. */
  suppliers: { supplierId: string; supplierName: string; allocatedKg: string; dispatchedKg: string; lots: number }[];
};

function notFound(what: string): never {
  throw new DomainError("NOT_FOUND", `${what} not found`);
}

export async function lotTrace(db: DbOrTx, ctx: OrgContext, lotId: string): Promise<LotTrace> {
  const hide = ctx.restrictions.hidePrices;
  const [row] = await db
    .select({
      lot: lots,
      commodityName: commodities.name,
      gradeName: grades.name,
      supplier: {
        id: suppliers.id,
        name: suppliers.name,
        phone: suppliers.phone,
        village: suppliers.village,
        type: suppliers.type,
      },
      purchase: {
        id: purchases.id,
        purchaseNumber: purchases.purchaseNumber,
        purchaseDate: purchases.purchaseDate,
        grnNumber: purchases.grnNumber,
        status: purchases.status,
      },
      line: {
        id: purchaseLines.id,
        bags: purchaseLines.bags,
        grossKg: purchaseLines.grossKg,
        netKg: purchaseLines.netKg,
        moisturePercent: purchaseLines.moisturePercent,
        pricePerKgKobo: purchaseLines.pricePerKgKobo,
        amountKobo: purchaseLines.amountKobo,
      },
    })
    .from(lots)
    .innerJoin(commodities, eq(commodities.id, lots.commodityId))
    .innerJoin(grades, eq(grades.id, lots.gradeId))
    .innerJoin(suppliers, eq(suppliers.id, lots.supplierId))
    .innerJoin(purchaseLines, eq(purchaseLines.id, lots.purchaseLineId))
    .innerJoin(purchases, eq(purchases.id, purchaseLines.purchaseId))
    .where(and(eq(lots.organisationId, ctx.orgId), eq(lots.id, lotId)))
    .limit(1);
  if (!row) notFound("Lot");

  const movements = await db
    .select({
      id: stockMovements.id,
      occurredAt: stockMovements.occurredAt,
      type: stockMovements.type,
      warehouseId: stockMovements.warehouseId,
      warehouseName: warehouses.name,
      binName: bins.name,
      kg: stockMovements.kg,
      bags: stockMovements.bags,
      refType: stockMovements.refType,
      refId: stockMovements.refId,
    })
    .from(stockMovements)
    .innerJoin(warehouses, eq(warehouses.id, stockMovements.warehouseId))
    .leftJoin(bins, eq(bins.id, stockMovements.binId))
    .where(and(eq(stockMovements.organisationId, ctx.orgId), eq(stockMovements.lotId, lotId)))
    .orderBy(asc(stockMovements.occurredAt), asc(stockMovements.createdAt));

  const disp = await db
    .select({
      dispatchLineId: dispatchLines.id,
      dispatchId: dispatches.id,
      waybillNumber: dispatches.waybillNumber,
      dispatchedAt: dispatches.dispatchedAt,
      kg: dispatchLines.kg,
      salesOrderId: salesOrders.id,
      orderNumber: salesOrders.orderNumber,
      customerId: customers.id,
      customerName: customers.name,
    })
    .from(dispatchLines)
    .innerJoin(dispatches, eq(dispatches.id, dispatchLines.dispatchId))
    .innerJoin(lotAllocations, eq(lotAllocations.id, dispatchLines.lotAllocationId))
    .innerJoin(salesLines, eq(salesLines.id, lotAllocations.salesLineId))
    .innerJoin(salesOrders, eq(salesOrders.id, salesLines.salesOrderId))
    .innerJoin(customers, eq(customers.id, salesOrders.customerId))
    .where(and(eq(dispatchLines.organisationId, ctx.orgId), eq(lotAllocations.lotId, lotId)))
    .orderBy(asc(dispatches.dispatchedAt));

  let onHand: Grams = 0;
  for (const m of movements) onHand += kgToGrams(m.kg);

  const byCustomer = new Map<string, { customerId: string; customerName: string; grams: Grams }>();
  for (const d of disp) {
    const c = byCustomer.get(d.customerId) ?? { customerId: d.customerId, customerName: d.customerName, grams: 0 };
    c.grams += kgToGrams(d.kg);
    byCustomer.set(d.customerId, c);
  }

  return {
    lot: {
      id: row.lot.id,
      lotNumber: row.lot.lotNumber,
      commodityId: row.lot.commodityId,
      commodityName: row.commodityName,
      gradeId: row.lot.gradeId,
      gradeName: row.gradeName,
      receivedAt: row.lot.receivedAt,
      originalKg: row.lot.originalKg,
      originalBags: row.lot.originalBags,
      onHandKg: gramsToKg(onHand),
      purchasePricePerKgKobo: hide ? null : row.lot.purchasePricePerKgKobo,
      landedCostPerKgKobo: hide ? null : row.lot.landedCostPerKgKobo,
    },
    supplier: row.supplier,
    purchase: row.purchase,
    purchaseLine: {
      ...row.line,
      pricePerKgKobo: hide ? null : row.line.pricePerKgKobo,
      amountKobo: hide ? null : row.line.amountKobo,
    },
    movements,
    dispatches: disp,
    customers: [...byCustomer.values()].map((c) => ({
      customerId: c.customerId,
      customerName: c.customerName,
      kg: gramsToKg(c.grams),
    })),
  };
}

export async function saleTrace(db: DbOrTx, ctx: OrgContext, salesOrderId: string): Promise<SaleTrace> {
  const hide = ctx.restrictions.hidePrices;
  const [order] = await db
    .select({
      id: salesOrders.id,
      orderNumber: salesOrders.orderNumber,
      orderDate: salesOrders.orderDate,
      status: salesOrders.status,
      customerId: customers.id,
      customerName: customers.name,
    })
    .from(salesOrders)
    .innerJoin(customers, eq(customers.id, salesOrders.customerId))
    .where(and(eq(salesOrders.organisationId, ctx.orgId), eq(salesOrders.id, salesOrderId)))
    .limit(1);
  if (!order) notFound("Sales order");

  const lines = await db
    .select({
      salesLineId: salesLines.id,
      commodityName: commodities.name,
      gradeName: grades.name,
      kg: salesLines.kg,
      pricePerKgKobo: salesLines.pricePerKgKobo,
    })
    .from(salesLines)
    .innerJoin(commodities, eq(commodities.id, salesLines.commodityId))
    .innerJoin(grades, eq(grades.id, salesLines.gradeId))
    .where(and(eq(salesLines.organisationId, ctx.orgId), eq(salesLines.salesOrderId, salesOrderId)))
    .orderBy(asc(salesLines.createdAt));

  const lineIds = lines.map((l) => l.salesLineId);
  const allocs =
    lineIds.length === 0
      ? []
      : await db
          .select({
            allocationId: lotAllocations.id,
            salesLineId: lotAllocations.salesLineId,
            status: lotAllocations.status,
            allocatedKg: lotAllocations.kg,
            lotId: lots.id,
            lotNumber: lots.lotNumber,
            warehouseName: warehouses.name,
            supplierId: suppliers.id,
            supplierName: suppliers.name,
            purchaseId: purchases.id,
            purchaseNumber: purchases.purchaseNumber,
            purchaseDate: purchases.purchaseDate,
          })
          .from(lotAllocations)
          .innerJoin(lots, eq(lots.id, lotAllocations.lotId))
          .innerJoin(warehouses, eq(warehouses.id, lotAllocations.warehouseId))
          .innerJoin(suppliers, eq(suppliers.id, lots.supplierId))
          .innerJoin(purchaseLines, eq(purchaseLines.id, lots.purchaseLineId))
          .innerJoin(purchases, eq(purchases.id, purchaseLines.purchaseId))
          .where(and(eq(lotAllocations.organisationId, ctx.orgId), inArray(lotAllocations.salesLineId, lineIds)))
          .orderBy(asc(lots.receivedAt), asc(lots.lotNumber));

  const allocIds = allocs.map((a) => a.allocationId);
  const dispatched = new Map<string, Grams>();
  if (allocIds.length > 0) {
    const dl = await db
      .select({ allocationId: dispatchLines.lotAllocationId, kg: dispatchLines.kg })
      .from(dispatchLines)
      .where(and(eq(dispatchLines.organisationId, ctx.orgId), inArray(dispatchLines.lotAllocationId, allocIds)));
    for (const r of dl) dispatched.set(r.allocationId, (dispatched.get(r.allocationId) ?? 0) + kgToGrams(r.kg));
  }

  const bySupplier = new Map<
    string,
    { supplierId: string; supplierName: string; alloc: Grams; disp: Grams; lots: Set<string> }
  >();
  for (const a of allocs) {
    if (a.status === "cancelled") continue;
    const s = bySupplier.get(a.supplierId) ?? {
      supplierId: a.supplierId,
      supplierName: a.supplierName,
      alloc: 0,
      disp: 0,
      lots: new Set<string>(),
    };
    s.alloc += kgToGrams(a.allocatedKg);
    s.disp += dispatched.get(a.allocationId) ?? 0;
    s.lots.add(a.lotId);
    bySupplier.set(a.supplierId, s);
  }

  return {
    order,
    lines: lines.map((l) => ({
      ...l,
      pricePerKgKobo: hide ? null : l.pricePerKgKobo,
      allocations: allocs
        .filter((a) => a.salesLineId === l.salesLineId)
        .map((a) => ({
          allocationId: a.allocationId,
          status: a.status,
          allocatedKg: a.allocatedKg,
          dispatchedKg: gramsToKg(dispatched.get(a.allocationId) ?? 0),
          lotId: a.lotId,
          lotNumber: a.lotNumber,
          warehouseName: a.warehouseName,
          supplierId: a.supplierId,
          supplierName: a.supplierName,
          purchaseId: a.purchaseId,
          purchaseNumber: a.purchaseNumber,
          purchaseDate: a.purchaseDate,
        })),
    })),
    suppliers: [...bySupplier.values()]
      .sort((a, b) => b.alloc - a.alloc)
      .map((s) => ({
        supplierId: s.supplierId,
        supplierName: s.supplierName,
        allocatedKg: gramsToKg(s.alloc),
        dispatchedKg: gramsToKg(s.disp),
        lots: s.lots.size,
      })),
  };
}

