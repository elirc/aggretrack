import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  date,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { organization, user } from './auth';
import { drivers, expenseCategories, vehicles, warehouses } from './master';
import { purchases } from './purchases';
import { dispatches } from './sales';
import { lots } from './stock';

export const tripDirection = pgEnum('trip_direction', ['inbound', 'outbound']);

export const trips = pgTable(
  'trips',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organisationId: text('organisation_id')
      .notNull()
      .references(() => organization.id),
    tripNumber: text('trip_number').notNull(),
    direction: tripDirection('direction').notNull(),
    vehicleId: uuid('vehicle_id').references(() => vehicles.id),
    driverId: uuid('driver_id').references(() => drivers.id),
    origin: text('origin'),
    destination: text('destination'),
    tripDate: date('trip_date').notNull(),
    costKobo: bigint('cost_kobo', { mode: 'number' }).notNull().default(0),
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
    unique('trips_org_number_uq').on(t.organisationId, t.tripNumber),
    index('trips_org_date_idx').on(t.organisationId, t.tripDate),
    index('trips_org_direction_idx').on(t.organisationId, t.direction),
  ],
);

export const tripPurchases = pgTable(
  'trip_purchases',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organisationId: text('organisation_id')
      .notNull()
      .references(() => organization.id),
    tripId: uuid('trip_id')
      .notNull()
      .references(() => trips.id, { onDelete: 'cascade' }),
    purchaseId: uuid('purchase_id')
      .notNull()
      .references(() => purchases.id),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique('trip_purchases_trip_purchase_uq').on(t.tripId, t.purchaseId),
    index('trip_purchases_org_idx').on(t.organisationId),
    index('trip_purchases_purchase_idx').on(t.purchaseId),
  ],
);

export const tripDispatches = pgTable(
  'trip_dispatches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organisationId: text('organisation_id')
      .notNull()
      .references(() => organization.id),
    tripId: uuid('trip_id')
      .notNull()
      .references(() => trips.id, { onDelete: 'cascade' }),
    dispatchId: uuid('dispatch_id')
      .notNull()
      .references(() => dispatches.id),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique('trip_dispatches_trip_dispatch_uq').on(t.tripId, t.dispatchId),
    index('trip_dispatches_org_idx').on(t.organisationId),
    index('trip_dispatches_dispatch_idx').on(t.dispatchId),
  ],
);

export const expenses = pgTable(
  'expenses',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organisationId: text('organisation_id')
      .notNull()
      .references(() => organization.id),
    expenseNumber: text('expense_number').notNull(),
    categoryId: uuid('category_id')
      .notNull()
      .references(() => expenseCategories.id),
    amountKobo: bigint('amount_kobo', { mode: 'number' }).notNull(),
    expenseDate: date('expense_date').notNull(),
    // Attached to at most one of lot / trip / warehouse.
    lotId: uuid('lot_id').references(() => lots.id),
    tripId: uuid('trip_id').references(() => trips.id),
    warehouseId: uuid('warehouse_id').references(() => warehouses.id),
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
    check(
      'expenses_single_attachment_check',
      sql`num_nonnulls(lot_id, trip_id, warehouse_id) <= 1`,
    ),
    unique('expenses_org_number_uq').on(t.organisationId, t.expenseNumber),
    index('expenses_org_date_idx').on(t.organisationId, t.expenseDate),
    index('expenses_trip_idx').on(t.tripId),
    index('expenses_lot_idx').on(t.lotId),
  ],
);
