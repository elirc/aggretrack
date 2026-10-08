import {
  bigint,
  boolean,
  date,
  index,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { organization, user } from './auth';

export const commodities = pgTable(
  'commodities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organisationId: text('organisation_id')
      .notNull()
      .references(() => organization.id),
    name: text('name').notNull(),
    code: text('code').notNull(),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique('commodities_org_name_uq').on(t.organisationId, t.name),
    unique('commodities_org_code_uq').on(t.organisationId, t.code),
  ],
);

export const grades = pgTable(
  'grades',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organisationId: text('organisation_id')
      .notNull()
      .references(() => organization.id),
    commodityId: uuid('commodity_id')
      .notNull()
      .references(() => commodities.id),
    name: text('name').notNull(),
    code: text('code'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique('grades_commodity_name_uq').on(t.commodityId, t.name),
    index('grades_org_idx').on(t.organisationId),
  ],
);

export const bagTypes = pgTable(
  'bag_types',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organisationId: text('organisation_id')
      .notNull()
      .references(() => organization.id),
    name: text('name').notNull(),
    standardKg: numeric('standard_kg', { precision: 12, scale: 3 }).notNull(),
    sackWeightKg: numeric('sack_weight_kg', { precision: 12, scale: 3 })
      .notNull()
      .default('0'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [unique('bag_types_org_name_uq').on(t.organisationId, t.name)],
);

export const buyingPoints = pgTable(
  'buying_points',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organisationId: text('organisation_id')
      .notNull()
      .references(() => organization.id),
    name: text('name').notNull(),
    lga: text('lga'),
    state: text('state'),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [unique('buying_points_org_name_uq').on(t.organisationId, t.name)],
);

export const warehouses = pgTable(
  'warehouses',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organisationId: text('organisation_id')
      .notNull()
      .references(() => organization.id),
    name: text('name').notNull(),
    location: text('location'),
    capacityKg: numeric('capacity_kg', { precision: 12, scale: 3 }),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [unique('warehouses_org_name_uq').on(t.organisationId, t.name)],
);

export const bins = pgTable(
  'bins',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organisationId: text('organisation_id')
      .notNull()
      .references(() => organization.id),
    warehouseId: uuid('warehouse_id')
      .notNull()
      .references(() => warehouses.id),
    name: text('name').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique('bins_warehouse_name_uq').on(t.warehouseId, t.name),
    index('bins_org_idx').on(t.organisationId),
  ],
);

export const vehicles = pgTable(
  'vehicles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organisationId: text('organisation_id')
      .notNull()
      .references(() => organization.id),
    plateNumber: text('plate_number').notNull(),
    description: text('description'),
    capacityKg: numeric('capacity_kg', { precision: 12, scale: 3 }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [unique('vehicles_org_plate_uq').on(t.organisationId, t.plateNumber)],
);

export const drivers = pgTable(
  'drivers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organisationId: text('organisation_id')
      .notNull()
      .references(() => organization.id),
    name: text('name').notNull(),
    phone: text('phone'),
    licenceNote: text('licence_note'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [unique('drivers_org_name_uq').on(t.organisationId, t.name)],
);

export const expenseCategories = pgTable(
  'expense_categories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organisationId: text('organisation_id')
      .notNull()
      .references(() => organization.id),
    name: text('name').notNull(),
    // Flagged categories share into lot landed cost when attached to an
    // inbound trip or directly to a lot.
    affectsLandedCost: boolean('affects_landed_cost').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [unique('expense_categories_org_name_uq').on(t.organisationId, t.name)],
);

// Lookup rule: most specific match wins (grade+point > grade > point > none),
// latest guide_date <= purchase_date.
export const priceGuides = pgTable(
  'price_guides',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organisationId: text('organisation_id')
      .notNull()
      .references(() => organization.id),
    commodityId: uuid('commodity_id')
      .notNull()
      .references(() => commodities.id),
    gradeId: uuid('grade_id').references(() => grades.id),
    buyingPointId: uuid('buying_point_id').references(() => buyingPoints.id),
    guideDate: date('guide_date').notNull(),
    maxPricePerKgKobo: bigint('max_price_per_kg_kobo', {
      mode: 'number',
    }).notNull(),
    createdBy: text('created_by').references(() => user.id),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique('price_guides_scope_uq').on(
      t.organisationId,
      t.commodityId,
      t.gradeId,
      t.buyingPointId,
      t.guideDate,
    ),
    index('price_guides_org_date_idx').on(t.organisationId, t.guideDate),
  ],
);
