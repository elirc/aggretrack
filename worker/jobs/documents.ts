/**
 * document.generate handler: assemble props → renderPdf → storeDocument →
 * point the owning row at the new document.
 *
 * Payload modes:
 *  - props-in-payload: `{ kind, refId, orgId, props }` — used by statements
 *    (assembled by callers, Wave 4) and allowed for any kind.
 *  - refId assembly: `{ kind, refId, orgId }` — grn (purchase id), waybill
 *    (dispatch id), invoice (invoice id). Missing / not-yet-numbered ref rows
 *    are skipped with console.warn (no retry storm).
 */
import type { Job } from "pg-boss";
import { and, eq, inArray, sql } from "drizzle-orm";

import { db, type DbOrTx } from "../../src/db/client";
import {
  buyingPoints,
  commodities,
  customerPaymentAllocations,
  customers,
  dispatches,
  dispatchLines,
  drivers,
  grades,
  invoices,
  lotAllocations,
  lots,
  organization,
  purchaseLineDeductions,
  purchaseLines,
  purchases,
  salesLines,
  salesOrders,
  suppliers,
  user,
  vehicles,
  warehouses,
} from "../../src/db/schema";
import type { DocType } from "../../src/lib/domain/numbering";
import { kgToGrams } from "../../src/lib/domain/units";
import type { DocumentGenerateJob, DocumentKind } from "../../src/lib/jobs";
import { storeDocument } from "../../src/lib/services/documents";
import { isPdfKind, renderPdf } from "../../src/pdf/render";
import type {
  GrnProps,
  InvoiceProps,
  PdfOrg,
  PdfPropsMap,
  WaybillProps,
} from "../../src/pdf/types";

/** Queue payload, optionally carrying fully-assembled template props. */
export type DocumentGenerateJobData = DocumentGenerateJob & {
  props?: PdfPropsMap[DocumentKind];
};

/**
 * documents.type for each kind. The doc_type enum has no statement values
 * (DECISIONS #4), so statements are filed under the supplier-payment /
 * customer-payment types with refType null and refId = supplier/customer id.
 */
const DOC_TYPE: Record<DocumentKind, DocType> = {
  grn: "grn",
  waybill: "wb",
  invoice: "inv",
  supplier_statement: "spm",
  customer_statement: "cpm",
};

const REF_TYPE: Record<DocumentKind, DocType | null> = {
  grn: "grn",
  waybill: "wb",
  invoice: "inv",
  supplier_statement: null,
  customer_statement: null,
};

type Assembled<K extends DocumentKind> = { props: PdfPropsMap[K]; number: string | null };

async function loadOrg(dbx: DbOrTx, orgId: string): Promise<PdfOrg | null> {
  const [org] = await dbx
    .select({ name: organization.name })
    .from(organization)
    .where(eq(organization.id, orgId))
    .limit(1);
  return org ? { name: org.name } : null;
}

function supplierAddress(s: { village: string | null; lga: string | null; state: string | null }) {
  return [s.village, s.lga, s.state];
}

// --- GRN (refId = purchase id) -------------------------------------------

export async function assembleGrn(
  dbx: DbOrTx,
  orgId: string,
  purchaseId: string,
): Promise<Assembled<"grn"> | null> {
  const [p] = await dbx
    .select({
      purchase: purchases,
      supplier: suppliers,
      warehouseName: warehouses.name,
      buyingPointName: buyingPoints.name,
      officerName: user.name,
    })
    .from(purchases)
    .innerJoin(suppliers, eq(suppliers.id, purchases.supplierId))
    .leftJoin(warehouses, eq(warehouses.id, purchases.receivedWarehouseId))
    .leftJoin(buyingPoints, eq(buyingPoints.id, purchases.buyingPointId))
    .leftJoin(user, eq(user.id, purchases.officerId))
    .where(and(eq(purchases.id, purchaseId), eq(purchases.organisationId, orgId)))
    .limit(1);
  if (!p) return null;
  const grnNumber = p.purchase.grnNumber;
  if (!grnNumber) {
    console.warn(`[documents] grn: purchase ${purchaseId} has no GRN number yet (not received); skipping`);
    return null;
  }
  const org = await loadOrg(dbx, orgId);
  if (!org) return null;

  const lineRows = await dbx
    .select({
      id: purchaseLines.id,
      commodity: commodities.name,
      grade: grades.name,
      bags: purchaseLines.bags,
      grossKg: purchaseLines.grossKg,
      netKg: purchaseLines.netKg,
      pricePerKgKobo: purchaseLines.pricePerKgKobo,
      amountKobo: purchaseLines.amountKobo,
      lotNumber: lots.lotNumber,
    })
    .from(purchaseLines)
    .innerJoin(commodities, eq(commodities.id, purchaseLines.commodityId))
    .innerJoin(grades, eq(grades.id, purchaseLines.gradeId))
    .leftJoin(lots, eq(lots.purchaseLineId, purchaseLines.id))
    .where(and(eq(purchaseLines.purchaseId, purchaseId), eq(purchaseLines.organisationId, orgId)))
    .orderBy(purchaseLines.createdAt, purchaseLines.id);

  const lineIds = lineRows.map((l) => l.id);
  const deductionRows = lineIds.length
    ? await dbx
        .select({
          lineId: purchaseLineDeductions.purchaseLineId,
          kg: sql<string>`coalesce(sum(${purchaseLineDeductions.kg}), 0)::text`,
        })
        .from(purchaseLineDeductions)
        .where(
          and(
            eq(purchaseLineDeductions.organisationId, orgId),
            inArray(purchaseLineDeductions.purchaseLineId, lineIds),
          ),
        )
        .groupBy(purchaseLineDeductions.purchaseLineId)
    : [];
  const deductions = new Map(deductionRows.map((d) => [d.lineId, kgToGrams(d.kg)]));

  const props: GrnProps = {
    org,
    grnNumber,
    purchaseNumber: p.purchase.purchaseNumber,
    purchaseDate: p.purchase.purchaseDate,
    receivedAt: p.purchase.receivedAt?.toISOString() ?? null,
    receivedWarehouse: p.warehouseName,
    buyingPoint: p.buyingPointName,
    officer: p.officerName,
    supplier: {
      name: p.supplier.name,
      phone: p.supplier.phone,
      addressLines: supplierAddress(p.supplier),
    },
    lines: lineRows.map((l) => {
      const gross = kgToGrams(l.grossKg);
      const net = kgToGrams(l.netKg);
      return {
        commodity: l.commodity,
        grade: l.grade,
        bags: l.bags,
        grossGrams: gross,
        // Recorded deductions; fall back to gross − net when none itemised.
        deductionGrams: deductions.get(l.id) ?? gross - net,
        netGrams: net,
        pricePerKgKobo: l.pricePerKgKobo,
        amountKobo: l.amountKobo,
        lotNumber: l.lotNumber,
      };
    }),
    totalAmountKobo: p.purchase.totalAmountKobo,
    generatedAt: new Date().toISOString(),
  };
  return { props, number: grnNumber };
}

// --- Waybill (refId = dispatch id) ---------------------------------------

export async function assembleWaybill(
  dbx: DbOrTx,
  orgId: string,
  dispatchId: string,
): Promise<Assembled<"waybill"> | null> {
  const [d] = await dbx
    .select({
      dispatch: dispatches,
      orderNumber: salesOrders.orderNumber,
      customer: customers,
      plateNumber: vehicles.plateNumber,
      vehicleDescription: vehicles.description,
      driverName: drivers.name,
      driverPhone: drivers.phone,
    })
    .from(dispatches)
    .innerJoin(salesOrders, eq(salesOrders.id, dispatches.salesOrderId))
    .innerJoin(customers, eq(customers.id, salesOrders.customerId))
    .leftJoin(vehicles, eq(vehicles.id, dispatches.vehicleId))
    .leftJoin(drivers, eq(drivers.id, dispatches.driverId))
    .where(and(eq(dispatches.id, dispatchId), eq(dispatches.organisationId, orgId)))
    .limit(1);
  if (!d) return null;
  const waybillNumber = d.dispatch.waybillNumber;
  if (!waybillNumber) {
    console.warn(`[documents] waybill: dispatch ${dispatchId} has no waybill number yet; skipping`);
    return null;
  }
  const org = await loadOrg(dbx, orgId);
  if (!org) return null;

  const lineRows = await dbx
    .select({
      kg: dispatchLines.kg,
      lotNumber: lots.lotNumber,
      commodity: commodities.name,
      grade: grades.name,
      warehouseName: warehouses.name,
    })
    .from(dispatchLines)
    .innerJoin(lotAllocations, eq(lotAllocations.id, dispatchLines.lotAllocationId))
    .innerJoin(lots, eq(lots.id, lotAllocations.lotId))
    .innerJoin(commodities, eq(commodities.id, lots.commodityId))
    .innerJoin(grades, eq(grades.id, lots.gradeId))
    .innerJoin(warehouses, eq(warehouses.id, lotAllocations.warehouseId))
    .where(and(eq(dispatchLines.dispatchId, dispatchId), eq(dispatchLines.organisationId, orgId)))
    .orderBy(lots.lotNumber);

  const warehouseNames = [...new Set(lineRows.map((l) => l.warehouseName))];

  const props: WaybillProps = {
    org,
    waybillNumber,
    dispatchedAt: d.dispatch.dispatchedAt.toISOString(),
    salesOrderNumber: d.orderNumber,
    customer: {
      name: d.customer.name,
      phone: d.customer.phone,
      addressLines: [d.customer.address, d.customer.state],
    },
    fromWarehouse: warehouseNames.length ? warehouseNames.join(", ") : null,
    vehicle: d.plateNumber ? { plateNumber: d.plateNumber, description: d.vehicleDescription } : null,
    driver: d.driverName ? { name: d.driverName, phone: d.driverPhone } : null,
    // dispatch_lines carry kg only; bags are not tracked per dispatch line.
    lines: lineRows.map((l) => ({
      lotNumber: l.lotNumber,
      commodity: l.commodity,
      grade: l.grade,
      grams: kgToGrams(l.kg),
      bags: null,
    })),
    dispatchedGrams: kgToGrams(d.dispatch.dispatchedKg),
    deliveredGrams: d.dispatch.deliveredKg == null ? null : kgToGrams(d.dispatch.deliveredKg),
    generatedAt: new Date().toISOString(),
  };
  return { props, number: waybillNumber };
}

// --- Invoice (refId = invoice id) ----------------------------------------

export async function assembleInvoice(
  dbx: DbOrTx,
  orgId: string,
  invoiceId: string,
): Promise<Assembled<"invoice"> | null> {
  const [inv] = await dbx
    .select({
      invoice: invoices,
      customer: customers,
      orderNumber: salesOrders.orderNumber,
      waybillNumber: dispatches.waybillNumber,
    })
    .from(invoices)
    .innerJoin(customers, eq(customers.id, invoices.customerId))
    .innerJoin(salesOrders, eq(salesOrders.id, invoices.salesOrderId))
    .leftJoin(dispatches, eq(dispatches.id, invoices.dispatchId))
    .where(and(eq(invoices.id, invoiceId), eq(invoices.organisationId, orgId)))
    .limit(1);
  if (!inv) return null;
  const org = await loadOrg(dbx, orgId);
  if (!org) return null;

  // No invoice_lines table: lines are the sales order's lines.
  const lineRows = await dbx
    .select({
      commodity: commodities.name,
      grade: grades.name,
      kg: salesLines.kg,
      pricePerKgKobo: salesLines.pricePerKgKobo,
      amountKobo: salesLines.amountKobo,
    })
    .from(salesLines)
    .innerJoin(commodities, eq(commodities.id, salesLines.commodityId))
    .innerJoin(grades, eq(grades.id, salesLines.gradeId))
    .where(and(eq(salesLines.salesOrderId, inv.invoice.salesOrderId), eq(salesLines.organisationId, orgId)))
    .orderBy(salesLines.createdAt, salesLines.id);

  const [paid] = await dbx
    .select({ kobo: sql<string>`coalesce(sum(${customerPaymentAllocations.amountKobo}), 0)::text` })
    .from(customerPaymentAllocations)
    .where(
      and(
        eq(customerPaymentAllocations.organisationId, orgId),
        eq(customerPaymentAllocations.invoiceId, invoiceId),
      ),
    );

  const props: InvoiceProps = {
    org,
    invoiceNumber: inv.invoice.invoiceNumber,
    invoiceDate: inv.invoice.invoiceDate,
    dueDate: inv.invoice.dueDate,
    salesOrderNumber: inv.orderNumber,
    waybillNumber: inv.waybillNumber,
    customer: {
      name: inv.customer.name,
      phone: inv.customer.phone,
      addressLines: [inv.customer.address, inv.customer.state],
    },
    lines: lineRows.map((l) => ({
      description: l.commodity,
      grade: l.grade,
      grams: kgToGrams(l.kg),
      pricePerKgKobo: l.pricePerKgKobo,
      amountKobo: l.amountKobo,
    })),
    subtotalKobo: inv.invoice.subtotalKobo,
    taxPercent: inv.invoice.taxPercent,
    taxKobo: inv.invoice.taxKobo,
    totalKobo: inv.invoice.totalKobo,
    paidKobo: Number(paid?.kobo ?? 0),
    status: inv.invoice.status,
    bankDetails: null, // placeholder until org bank details exist in settings
    generatedAt: new Date().toISOString(),
  };
  return { props, number: inv.invoice.invoiceNumber };
}

async function assemble(
  dbx: DbOrTx,
  data: DocumentGenerateJobData,
): Promise<Assembled<DocumentKind> | null> {
  switch (data.kind) {
    case "grn":
      return assembleGrn(dbx, data.orgId, data.refId);
    case "waybill":
      return assembleWaybill(dbx, data.orgId, data.refId);
    case "invoice":
      return assembleInvoice(dbx, data.orgId, data.refId);
    case "supplier_statement":
    case "customer_statement":
      // Statement assembly lands in Wave 4 (P4-D); until then callers pass props.
      console.warn(`[documents] ${data.kind}: no props in payload and ref assembly not implemented; skipping`);
      return null;
  }
}

/** Number used for the documents row when props come from the payload. */
function numberFromProps(kind: DocumentKind, props: PdfPropsMap[DocumentKind]): string | null {
  switch (kind) {
    case "grn":
      return (props as GrnProps).grnNumber;
    case "waybill":
      return (props as WaybillProps).waybillNumber;
    case "invoice":
      return (props as InvoiceProps).invoiceNumber;
    default:
      return null;
  }
}

async function linkOwner(dbx: DbOrTx, data: DocumentGenerateJobData, documentId: string): Promise<void> {
  const now = new Date();
  switch (data.kind) {
    case "grn":
      await dbx
        .update(purchases)
        .set({ grnDocumentId: documentId, updatedAt: now })
        .where(and(eq(purchases.id, data.refId), eq(purchases.organisationId, data.orgId)));
      return;
    case "waybill":
      await dbx
        .update(dispatches)
        .set({ waybillDocumentId: documentId, updatedAt: now })
        .where(and(eq(dispatches.id, data.refId), eq(dispatches.organisationId, data.orgId)));
      return;
    case "invoice":
      await dbx
        .update(invoices)
        .set({ documentId, updatedAt: now })
        .where(and(eq(invoices.id, data.refId), eq(invoices.organisationId, data.orgId)));
      return;
    default:
      return; // statements have no owning column
  }
}

/** Process one payload. Returns the stored document id, or null when skipped. */
export async function generateDocument(data: DocumentGenerateJobData): Promise<string | null> {
  if (!data || !data.orgId || !data.refId || !isPdfKind(String(data.kind))) {
    console.warn("[documents] invalid document.generate payload; skipping", data);
    return null;
  }

  let assembled: Assembled<DocumentKind> | null;
  if (data.props) {
    assembled = { props: data.props, number: numberFromProps(data.kind, data.props) };
  } else {
    assembled = await assemble(db, data);
    if (!assembled) {
      console.warn(`[documents] ${data.kind}: ref ${data.refId} not found in org ${data.orgId} (or not ready); skipping`);
      return null;
    }
  }

  // Render outside the tx (CPU-bound; keeps the tx short).
  const buffer = await renderPdf(data.kind, assembled.props as never);

  const number = assembled.number;
  return db.transaction(async (tx) => {
    const { id } = await storeDocument(
      tx,
      { orgId: data.orgId, userId: null },
      {
        type: DOC_TYPE[data.kind],
        number,
        refType: REF_TYPE[data.kind],
        refId: data.refId,
        buffer,
      },
    );
    await linkOwner(tx, data, id);
    return id;
  });
}

export async function handleDocumentGenerate(jobs: Job<DocumentGenerateJobData>[]): Promise<void> {
  for (const job of jobs) {
    // Throwing lets pg-boss retry per the queue/send options.
    const id = await generateDocument(job.data);
    if (id) console.log(`[documents] ${job.data.kind} ${job.data.refId} -> document ${id}`);
  }
}
