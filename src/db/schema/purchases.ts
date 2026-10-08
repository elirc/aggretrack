import {
  bigint,
  boolean,
  date,
  index,
  integer,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { organization, user } from './auth';
import { bagTypes, buyingPoints, commodities, grades, warehouses } from './master';
import { suppliers } from './suppliers';
import { documents } from './system';

export const purchaseStatus = pgEnum('purchase_status', [
  'draft',
  'pending_approval',
  'approved',
  'received',
  'cancelled',
]);

export const deductionReason = pgEnum('deduction_reason', [
  'moisture',
  'foreign_matter',
  'sack_weight',
  'other',
]);

export const purchases = pgTable(
  'purchases',
  {
    // Client-generated offline: PK uniqueness is the sync idempotency guard.
    id: uuid('id').primaryKey().defaultRandom(),
    organisationId: text('organisation_id')
      .notNull()
      .references(() => organization.id),
    // Assigned server-side on first save/sync; nullable until numbered.
    purchaseNumber: text('purchase_number'),
    supplierId: uuid('supplier_id')
      .notNull()
      .references(() => suppliers.id),
    buyingPointId: uuid('buying_point_id').references(() => buyingPoints.id),
    officerId: text('officer_id')
      .notNull()
      .references(() => user.id),
    purchaseDate: date('purchase_date').notNull(),
    status: purchaseStatus('status').notNull().default('draft'),
    totalAmountKobo: bigint('total_amount_kobo', { mode: 'number' })
      .notNull()
      .default(0),
    requiresApproval: boolean('requires_approval').notNull().default(false),
    approvedBy: text('approved_by').references(() => user.id),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    rejectedReason: text('rejected_reason'),
    createdOffline: boolean('created_offline').notNull().default(false),
    clientCreatedAt: timestamp('client_created_at', { withTimezone: true }),
    receivedWarehouseId: uuid('received_warehouse_id').references(
      () => warehouses.id,
    ),
    receivedAt: timestamp('received_at', { withTimezone: true }),
    grnNumber: text('grn_number'),
    grnDocumentId: uuid('grn_document_id').references(() => documents.id),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique('purchases_org_number_uq').on(t.organisationId, t.purchaseNumber),
    index('purchases_org_date_idx').on(t.organisationId, t.purchaseDate),
    index('purchases_org_supplier_idx').on(t.organisationId, t.supplierId),
    index('purchases_org_status_idx').on(t.organisationId, t.status),
  ],
);

export const purchaseLines = pgTable(
  'purchase_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    purchaseId: uuid('purchase_id')
      .notNull()
      .references(() => purchases.id, { onDelete: 'cascade' }),
    organisationId: text('organisation_id')
      .notNull()
      .references(() => organization.id),
    commodityId: uuid('commodity_id')
      .notNull()
      .references(() => commodities.id),
    gradeId: uuid('grade_id')
      .notNull()
      .references(() => grades.id),
    bagTypeId: uuid('bag_type_id').references(() => bagTypes.id),
    bags: integer('bags').notNull().default(0),
    grossKg: numeric('gross_kg', { precision: 12, scale: 3 }).notNull(),
    netKg: numeric('net_kg', { precision: 12, scale: 3 }).notNull(),
    moisturePercent: numeric('moisture_percent', { precision: 5, scale: 2 }),
    pricePerKgKobo: bigint('price_per_kg_kobo', { mode: 'number' }).notNull(),
    amountKobo: bigint('amount_kobo', { mode: 'number' }).notNull(),
    // Price exceeded the day's guide at entry time.
    overGuide: boolean('over_guide').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('purchase_lines_purchase_idx').on(t.purchaseId),
    index('purchase_lines_org_idx').on(t.organisationId),
  ],
);

// Separate table, not jsonb — supplier quality-deduction history needs
// grouping by reason.
export const purchaseLineDeductions = pgTable(
  'purchase_line_deductions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    purchaseLineId: uuid('purchase_line_id')
      .notNull()
      .references(() => purchaseLines.id, { onDelete: 'cascade' }),
    organisationId: text('organisation_id')
      .notNull()
      .references(() => organization.id),
    reason: deductionReason('reason').notNull(),
    kg: numeric('kg', { precision: 12, scale: 3 }).notNull(),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('purchase_line_deductions_line_idx').on(t.purchaseLineId),
    index('purchase_line_deductions_org_idx').on(t.organisationId),
  ],
);
