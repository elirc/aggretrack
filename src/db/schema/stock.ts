import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
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
import { bins, commodities, grades, warehouses } from './master';
import { purchaseLines } from './purchases';
import { suppliers } from './suppliers';
import { docType } from './system';

export const movementType = pgEnum('movement_type', [
  'receive',
  'transfer_out',
  'transfer_in',
  'adjustment',
  'dispatch',
  'return',
]);

export const transferStatus = pgEnum('transfer_status', [
  'draft',
  'in_transit',
  'received',
  'cancelled',
]);

export const adjustmentReason = pgEnum('adjustment_reason', [
  'shrinkage',
  'spoilage',
  'theft',
  're_bagging',
  'count_difference',
]);

export const adjustmentStatus = pgEnum('adjustment_status', [
  'pending_approval',
  'posted',
  'rejected',
]);

export const countStatus = pgEnum('count_status', [
  'draft',
  'posted',
  'cancelled',
]);

export const lots = pgTable(
  'lots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organisationId: text('organisation_id')
      .notNull()
      .references(() => organization.id),
    lotNumber: text('lot_number').notNull(),
    commodityId: uuid('commodity_id')
      .notNull()
      .references(() => commodities.id),
    gradeId: uuid('grade_id')
      .notNull()
      .references(() => grades.id),
    supplierId: uuid('supplier_id')
      .notNull()
      .references(() => suppliers.id),
    purchaseLineId: uuid('purchase_line_id')
      .notNull()
      .unique()
      .references(() => purchaseLines.id),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull(),
    originalKg: numeric('original_kg', { precision: 12, scale: 3 }).notNull(),
    originalBags: integer('original_bags').notNull().default(0),
    purchasePricePerKgKobo: bigint('purchase_price_per_kg_kobo', {
      mode: 'number',
    }).notNull(),
    // Initialised = purchase price; recomputed when trip costs/expenses attach.
    landedCostPerKgKobo: numeric('landed_cost_per_kg_kobo', {
      precision: 14,
      scale: 4,
    }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique('lots_org_number_uq').on(t.organisationId, t.lotNumber),
    index('lots_org_commodity_grade_idx').on(
      t.organisationId,
      t.commodityId,
      t.gradeId,
    ),
    index('lots_org_received_idx').on(t.organisationId, t.receivedAt),
  ],
);

// APPEND-ONLY. No update, no delete, ever. Corrections are new rows.
// kg and bags are SIGNED: receive/transfer_in/return > 0; transfer_out/
// dispatch < 0; adjustment either sign.
export const stockMovements = pgTable(
  'stock_movements',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organisationId: text('organisation_id')
      .notNull()
      .references(() => organization.id),
    lotId: uuid('lot_id')
      .notNull()
      .references(() => lots.id),
    warehouseId: uuid('warehouse_id')
      .notNull()
      .references(() => warehouses.id),
    binId: uuid('bin_id').references(() => bins.id),
    type: movementType('type').notNull(),
    kg: numeric('kg', { precision: 12, scale: 3 }).notNull(),
    bags: integer('bags').notNull().default(0),
    refType: docType('ref_type'),
    refId: uuid('ref_id'),
    createdBy: text('created_by').references(() => user.id),
    occurredAt: timestamp('occurred_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check(
      'stock_movements_sign_check',
      sql`(type IN ('receive', 'transfer_in', 'return') AND kg > 0) OR (type IN ('transfer_out', 'dispatch') AND kg < 0) OR (type = 'adjustment')`,
    ),
    index('stock_movements_org_lot_idx').on(t.organisationId, t.lotId),
    index('stock_movements_org_warehouse_idx').on(
      t.organisationId,
      t.warehouseId,
    ),
    index('stock_movements_org_occurred_idx').on(
      t.organisationId,
      t.occurredAt,
    ),
    index('stock_movements_lot_warehouse_idx').on(t.lotId, t.warehouseId),
  ],
);

export const transfers = pgTable(
  'transfers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organisationId: text('organisation_id')
      .notNull()
      .references(() => organization.id),
    transferNumber: text('transfer_number').notNull(),
    fromWarehouseId: uuid('from_warehouse_id')
      .notNull()
      .references(() => warehouses.id),
    toWarehouseId: uuid('to_warehouse_id')
      .notNull()
      .references(() => warehouses.id),
    status: transferStatus('status').notNull().default('draft'),
    dispatchedAt: timestamp('dispatched_at', { withTimezone: true }),
    receivedAt: timestamp('received_at', { withTimezone: true }),
    createdBy: text('created_by').references(() => user.id),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique('transfers_org_number_uq').on(t.organisationId, t.transferNumber),
    check(
      'transfers_from_to_check',
      sql`from_warehouse_id <> to_warehouse_id`,
    ),
    index('transfers_org_status_idx').on(t.organisationId, t.status),
  ],
);

// In-transit stock = lines of transfers with status in_transit (transfer_out
// posted, transfer_in not yet). Loss needs NO extra movement: out −kg,
// in +received_kg nets the loss out of global stock.
export const transferLines = pgTable(
  'transfer_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    transferId: uuid('transfer_id')
      .notNull()
      .references(() => transfers.id, { onDelete: 'cascade' }),
    organisationId: text('organisation_id')
      .notNull()
      .references(() => organization.id),
    lotId: uuid('lot_id')
      .notNull()
      .references(() => lots.id),
    kg: numeric('kg', { precision: 12, scale: 3 }).notNull(),
    bags: integer('bags').notNull().default(0),
    receivedKg: numeric('received_kg', { precision: 12, scale: 3 }),
    receivedBags: integer('received_bags'),
    lossKg: numeric('loss_kg', { precision: 12, scale: 3 }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('transfer_lines_transfer_idx').on(t.transferId),
    index('transfer_lines_org_idx').on(t.organisationId),
  ],
);

export const stockCounts = pgTable(
  'stock_counts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organisationId: text('organisation_id')
      .notNull()
      .references(() => organization.id),
    countNumber: text('count_number').notNull(),
    warehouseId: uuid('warehouse_id')
      .notNull()
      .references(() => warehouses.id),
    status: countStatus('status').notNull().default('draft'),
    countedAt: timestamp('counted_at', { withTimezone: true }).notNull(),
    postedAt: timestamp('posted_at', { withTimezone: true }),
    createdBy: text('created_by').references(() => user.id),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique('stock_counts_org_number_uq').on(t.organisationId, t.countNumber),
    index('stock_counts_org_warehouse_idx').on(
      t.organisationId,
      t.warehouseId,
    ),
  ],
);

export const stockCountLines = pgTable(
  'stock_count_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    countId: uuid('count_id')
      .notNull()
      .references(() => stockCounts.id, { onDelete: 'cascade' }),
    organisationId: text('organisation_id')
      .notNull()
      .references(() => organization.id),
    lotId: uuid('lot_id')
      .notNull()
      .references(() => lots.id),
    binId: uuid('bin_id').references(() => bins.id),
    countedBags: integer('counted_bags'),
    countedKg: numeric('counted_kg', { precision: 12, scale: 3 }).notNull(),
    // Snapshot of system stock at entry time.
    systemKg: numeric('system_kg', { precision: 12, scale: 3 }).notNull(),
    diffKg: numeric('diff_kg', { precision: 12, scale: 3 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('stock_count_lines_count_idx').on(t.countId),
    index('stock_count_lines_org_idx').on(t.organisationId),
  ],
);

// Movement row written only on post. Below org threshold → auto-approved and
// posted in one tx.
export const adjustments = pgTable(
  'adjustments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organisationId: text('organisation_id')
      .notNull()
      .references(() => organization.id),
    adjustmentNumber: text('adjustment_number').notNull(),
    lotId: uuid('lot_id')
      .notNull()
      .references(() => lots.id),
    warehouseId: uuid('warehouse_id')
      .notNull()
      .references(() => warehouses.id),
    binId: uuid('bin_id').references(() => bins.id),
    reason: adjustmentReason('reason').notNull(),
    kg: numeric('kg', { precision: 12, scale: 3 }).notNull(),
    bags: integer('bags').notNull().default(0),
    status: adjustmentStatus('status').notNull().default('pending_approval'),
    approvedBy: text('approved_by').references(() => user.id),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    rejectedReason: text('rejected_reason'),
    sourceCountId: uuid('source_count_id').references(() => stockCounts.id),
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
    unique('adjustments_org_number_uq').on(
      t.organisationId,
      t.adjustmentNumber,
    ),
    index('adjustments_org_status_idx').on(t.organisationId, t.status),
    index('adjustments_org_lot_idx').on(t.organisationId, t.lotId),
  ],
);
