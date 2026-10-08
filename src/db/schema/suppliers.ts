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
import { purchases } from './purchases';

export const supplierType = pgEnum('supplier_type', [
  'farmer',
  'agent',
  'cooperative',
]);

export const paymentMethod = pgEnum('payment_method', [
  'cash',
  'transfer',
  'pos',
]);

export const suppliers = pgTable(
  'suppliers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organisationId: text('organisation_id')
      .notNull()
      .references(() => organization.id),
    type: supplierType('type').notNull(),
    name: text('name').notNull(),
    phone: text('phone'),
    village: text('village'),
    lga: text('lga'),
    state: text('state'),
    bankName: text('bank_name'),
    bankAccountNumber: text('bank_account_number'),
    bankAccountName: text('bank_account_name'),
    idNote: text('id_note'),
    photoKey: text('photo_key'),
    createdBy: text('created_by').references(() => user.id),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('suppliers_org_name_idx').on(t.organisationId, t.name),
    index('suppliers_org_phone_idx').on(t.organisationId, t.phone),
  ],
);

// Outstanding = amount − Σ supplier_advance_offsets. No status column; derived.
export const supplierAdvances = pgTable(
  'supplier_advances',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organisationId: text('organisation_id')
      .notNull()
      .references(() => organization.id),
    supplierId: uuid('supplier_id')
      .notNull()
      .references(() => suppliers.id),
    advanceNumber: text('advance_number').notNull(),
    amountKobo: bigint('amount_kobo', { mode: 'number' }).notNull(),
    advanceDate: date('advance_date').notNull(),
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
    unique('supplier_advances_org_number_uq').on(
      t.organisationId,
      t.advanceNumber,
    ),
    index('supplier_advances_org_supplier_idx').on(
      t.organisationId,
      t.supplierId,
    ),
  ],
);

export const supplierPayments = pgTable(
  'supplier_payments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organisationId: text('organisation_id')
      .notNull()
      .references(() => organization.id),
    supplierId: uuid('supplier_id')
      .notNull()
      .references(() => suppliers.id),
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
    unique('supplier_payments_org_number_uq').on(
      t.organisationId,
      t.paymentNumber,
    ),
    index('supplier_payments_org_supplier_idx').on(
      t.organisationId,
      t.supplierId,
    ),
  ],
);

// Allocation to an advance = this payment funded/disbursed that advance.
export const supplierPaymentAllocations = pgTable(
  'supplier_payment_allocations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organisationId: text('organisation_id')
      .notNull()
      .references(() => organization.id),
    paymentId: uuid('payment_id')
      .notNull()
      .references(() => supplierPayments.id, { onDelete: 'cascade' }),
    purchaseId: uuid('purchase_id').references(() => purchases.id),
    advanceId: uuid('advance_id').references(() => supplierAdvances.id),
    amountKobo: bigint('amount_kobo', { mode: 'number' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check(
      'supplier_payment_allocations_one_target_check',
      sql`num_nonnulls(purchase_id, advance_id) = 1`,
    ),
    index('supplier_payment_allocations_org_idx').on(t.organisationId),
    index('supplier_payment_allocations_payment_idx').on(t.paymentId),
    index('supplier_payment_allocations_purchase_idx').on(t.purchaseId),
  ],
);

// Recovery of an advance against a purchase payable.
export const supplierAdvanceOffsets = pgTable(
  'supplier_advance_offsets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organisationId: text('organisation_id')
      .notNull()
      .references(() => organization.id),
    advanceId: uuid('advance_id')
      .notNull()
      .references(() => supplierAdvances.id),
    purchaseId: uuid('purchase_id')
      .notNull()
      .references(() => purchases.id),
    amountKobo: bigint('amount_kobo', { mode: 'number' }).notNull(),
    createdBy: text('created_by').references(() => user.id),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('supplier_advance_offsets_org_advance_idx').on(
      t.organisationId,
      t.advanceId,
    ),
    index('supplier_advance_offsets_org_purchase_idx').on(
      t.organisationId,
      t.purchaseId,
    ),
  ],
);
