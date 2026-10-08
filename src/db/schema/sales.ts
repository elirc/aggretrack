import {
  bigint,
  date,
  index,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { organization, user } from './auth';
import { commodities, drivers, grades, vehicles, warehouses } from './master';
import { lots } from './stock';
import { paymentMethod } from './suppliers';
import { documents } from './system';

export const salesOrderStatus = pgEnum('sales_order_status', [
  'draft',
  'confirmed',
  'allocated',
  'dispatched',
  'completed',
  'cancelled',
]);

export const allocationStatus = pgEnum('allocation_status', [
  'reserved',
  'dispatched',
  'cancelled',
]);

export const dispatchStatus = pgEnum('dispatch_status', [
  'in_transit',
  'delivered',
]);

export const invoiceStatus = pgEnum('invoice_status', [
  'issued',
  'part_paid',
  'paid',
  'void',
]);

export const customers = pgTable(
  'customers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organisationId: text('organisation_id')
      .notNull()
      .references(() => organization.id),
    name: text('name').notNull(),
    phone: text('phone'),
    email: text('email'),
    address: text('address'),
    state: text('state'),
    note: text('note'),
    createdBy: text('created_by').references(() => user.id),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('customers_org_name_idx').on(t.organisationId, t.name)],
);

export const salesOrders = pgTable(
  'sales_orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organisationId: text('organisation_id')
      .notNull()
      .references(() => organization.id),
    orderNumber: text('order_number').notNull(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id),
    orderDate: date('order_date').notNull(),
    status: salesOrderStatus('status').notNull().default('draft'),
    totalAmountKobo: bigint('total_amount_kobo', { mode: 'number' })
      .notNull()
      .default(0),
    createdBy: text('created_by').references(() => user.id),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique('sales_orders_org_number_uq').on(t.organisationId, t.orderNumber),
    index('sales_orders_org_date_idx').on(t.organisationId, t.orderDate),
    index('sales_orders_org_customer_idx').on(t.organisationId, t.customerId),
    index('sales_orders_org_status_idx').on(t.organisationId, t.status),
  ],
);

export const salesLines = pgTable(
  'sales_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    salesOrderId: uuid('sales_order_id')
      .notNull()
      .references(() => salesOrders.id, { onDelete: 'cascade' }),
    organisationId: text('organisation_id')
      .notNull()
      .references(() => organization.id),
    commodityId: uuid('commodity_id')
      .notNull()
      .references(() => commodities.id),
    gradeId: uuid('grade_id')
      .notNull()
      .references(() => grades.id),
    kg: numeric('kg', { precision: 12, scale: 3 }).notNull(),
    pricePerKgKobo: bigint('price_per_kg_kobo', { mode: 'number' }).notNull(),
    amountKobo: bigint('amount_kobo', { mode: 'number' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('sales_lines_order_idx').on(t.salesOrderId),
    index('sales_lines_org_idx').on(t.organisationId),
  ],
);

// Reservation layer, NOT movements.
// available(lot, warehouse) = Σ movements.kg − Σ allocations.kg where
// status = 'reserved'. Dispatch flips reserved→dispatched in the same tx that
// writes the dispatch movement, so it never double-counts.
export const lotAllocations = pgTable(
  'lot_allocations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organisationId: text('organisation_id')
      .notNull()
      .references(() => organization.id),
    salesLineId: uuid('sales_line_id')
      .notNull()
      .references(() => salesLines.id),
    lotId: uuid('lot_id')
      .notNull()
      .references(() => lots.id),
    warehouseId: uuid('warehouse_id')
      .notNull()
      .references(() => warehouses.id),
    kg: numeric('kg', { precision: 12, scale: 3 }).notNull(),
    status: allocationStatus('status').notNull().default('reserved'),
    createdBy: text('created_by').references(() => user.id),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('lot_allocations_lot_warehouse_status_idx').on(
      t.lotId,
      t.warehouseId,
      t.status,
    ),
    index('lot_allocations_org_sales_line_idx').on(
      t.organisationId,
      t.salesLineId,
    ),
  ],
);

export const dispatches = pgTable(
  'dispatches',
  {
    // Client-generated offline-capable id.
    id: uuid('id').primaryKey().defaultRandom(),
    organisationId: text('organisation_id')
      .notNull()
      .references(() => organization.id),
    // Assigned server-side; nullable until numbered (offline entry).
    waybillNumber: text('waybill_number'),
    salesOrderId: uuid('sales_order_id')
      .notNull()
      .references(() => salesOrders.id),
    vehicleId: uuid('vehicle_id').references(() => vehicles.id),
    driverId: uuid('driver_id').references(() => drivers.id),
    status: dispatchStatus('status').notNull().default('in_transit'),
    dispatchedKg: numeric('dispatched_kg', {
      precision: 12,
      scale: 3,
    }).notNull(),
    deliveredKg: numeric('delivered_kg', { precision: 12, scale: 3 }),
    // Set on delivery: dispatched − delivered. Reporting-only; stock already
    // left at dispatch.
    transitLossKg: numeric('transit_loss_kg', { precision: 12, scale: 3 }),
    dispatchedAt: timestamp('dispatched_at', { withTimezone: true }).notNull(),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    waybillDocumentId: uuid('waybill_document_id').references(
      () => documents.id,
    ),
    createdBy: text('created_by').references(() => user.id),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique('dispatches_org_waybill_uq').on(t.organisationId, t.waybillNumber),
    index('dispatches_org_order_idx').on(t.organisationId, t.salesOrderId),
    index('dispatches_org_status_idx').on(t.organisationId, t.status),
  ],
);

export const dispatchLines = pgTable(
  'dispatch_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    dispatchId: uuid('dispatch_id')
      .notNull()
      .references(() => dispatches.id, { onDelete: 'cascade' }),
    organisationId: text('organisation_id')
      .notNull()
      .references(() => organization.id),
    lotAllocationId: uuid('lot_allocation_id')
      .notNull()
      .references(() => lotAllocations.id),
    kg: numeric('kg', { precision: 12, scale: 3 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('dispatch_lines_dispatch_idx').on(t.dispatchId),
    index('dispatch_lines_org_idx').on(t.organisationId),
  ],
);

// Outstanding = total − Σ allocations; status derived part_paid/paid as
// allocations land.
export const invoices = pgTable(
  'invoices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organisationId: text('organisation_id')
      .notNull()
      .references(() => organization.id),
    invoiceNumber: text('invoice_number').notNull(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id),
    salesOrderId: uuid('sales_order_id')
      .notNull()
      .references(() => salesOrders.id),
    dispatchId: uuid('dispatch_id').references(() => dispatches.id),
    invoiceDate: date('invoice_date').notNull(),
    dueDate: date('due_date'),
    subtotalKobo: bigint('subtotal_kobo', { mode: 'number' }).notNull(),
    taxPercent: numeric('tax_percent', { precision: 5, scale: 2 })
      .notNull()
      .default('0'),
    taxKobo: bigint('tax_kobo', { mode: 'number' }).notNull().default(0),
    totalKobo: bigint('total_kobo', { mode: 'number' }).notNull(),
    status: invoiceStatus('status').notNull().default('issued'),
    documentId: uuid('document_id').references(() => documents.id),
    createdBy: text('created_by').references(() => user.id),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique('invoices_org_number_uq').on(t.organisationId, t.invoiceNumber),
    index('invoices_org_date_idx').on(t.organisationId, t.invoiceDate),
    index('invoices_org_customer_idx').on(t.organisationId, t.customerId),
    index('invoices_org_status_idx').on(t.organisationId, t.status),
  ],
);

export const customerPayments = pgTable(
  'customer_payments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organisationId: text('organisation_id')
      .notNull()
      .references(() => organization.id),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id),
    paymentNumber: text('payment_number').notNull(),
    amountKobo: bigint('amount_kobo', { mode: 'number' }).notNull(),
    method: paymentMethod('method').notNull(),
    paymentDate: date('payment_date').notNull(),
    reference: text('reference'),
    note: text('note'),
    createdBy: text('created_by').references(() => user.id),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique('customer_payments_org_number_uq').on(
      t.organisationId,
      t.paymentNumber,
    ),
    index('customer_payments_org_customer_idx').on(
      t.organisationId,
      t.customerId,
    ),
  ],
);

export const customerPaymentAllocations = pgTable(
  'customer_payment_allocations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organisationId: text('organisation_id')
      .notNull()
      .references(() => organization.id),
    paymentId: uuid('payment_id')
      .notNull()
      .references(() => customerPayments.id, { onDelete: 'cascade' }),
    invoiceId: uuid('invoice_id')
      .notNull()
      .references(() => invoices.id),
    amountKobo: bigint('amount_kobo', { mode: 'number' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('customer_payment_allocations_payment_idx').on(t.paymentId),
    index('customer_payment_allocations_invoice_idx').on(t.invoiceId),
    index('customer_payment_allocations_org_idx').on(t.organisationId),
  ],
);
