import {
  boolean,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { member, organization } from './auth';
import { buyingPoints, warehouses } from './master';

export const organisationSettings = pgTable('organisation_settings', {
  organisationId: text('organisation_id')
    .primaryKey()
    .references(() => organization.id),
  currency: text('currency').notNull().default('NGN'),
  timezone: text('timezone').notNull().default('Africa/Lagos'),
  adjustmentApprovalThresholdKg: numeric('adjustment_approval_threshold_kg', {
    precision: 12,
    scale: 3,
  })
    .notNull()
    .default('50'),
  lowStockThresholdKg: numeric('low_stock_threshold_kg', {
    precision: 12,
    scale: 3,
  })
    .notNull()
    .default('1000'),
  oldStockDays: integer('old_stock_days').notNull().default(90),
  capacityAlertPercent: integer('capacity_alert_percent').notNull().default(90),
  hidePricesFromWarehouse: boolean('hide_prices_from_warehouse')
    .notNull()
    .default(false),
  invoiceTaxPercent: numeric('invoice_tax_percent', { precision: 5, scale: 2 })
    .notNull()
    .default('0'),
  setupCompletedAt: timestamp('setup_completed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// No rows for a member = all warehouses allowed.
export const memberWarehouseAccess = pgTable(
  'member_warehouse_access',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organisationId: text('organisation_id')
      .notNull()
      .references(() => organization.id),
    memberId: text('member_id')
      .notNull()
      .references(() => member.id, { onDelete: 'cascade' }),
    warehouseId: uuid('warehouse_id')
      .notNull()
      .references(() => warehouses.id),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique('member_warehouse_access_member_warehouse_uq').on(
      t.memberId,
      t.warehouseId,
    ),
    index('member_warehouse_access_org_idx').on(t.organisationId),
  ],
);

// No rows for a member = all buying points allowed.
export const memberBuyingPointAccess = pgTable(
  'member_buying_point_access',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organisationId: text('organisation_id')
      .notNull()
      .references(() => organization.id),
    memberId: text('member_id')
      .notNull()
      .references(() => member.id, { onDelete: 'cascade' }),
    buyingPointId: uuid('buying_point_id')
      .notNull()
      .references(() => buyingPoints.id),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique('member_buying_point_access_member_point_uq').on(
      t.memberId,
      t.buyingPointId,
    ),
    index('member_buying_point_access_org_idx').on(t.organisationId),
  ],
);
