import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { organization, user } from './auth';

export const docType = pgEnum('doc_type', [
  'po',
  'grn',
  'lot',
  'trf',
  'wb',
  'so',
  'inv',
  'adj',
  'cnt',
  'adv',
  'spm',
  'cpm',
  'trp',
  'exp',
]);

export const notificationType = pgEnum('notification_type', [
  'low_stock',
  'old_stock',
  'capacity',
  'approval_request',
  'payment',
  'system',
]);

export const auditAction = pgEnum('audit_action', [
  'create',
  'update',
  'cancel',
  'approve',
  'reject',
  'post',
]);

// Gapless numbering. Allocation runs in the same tx as the row that consumes
// the number — rollback releases it, no gaps:
//   INSERT INTO document_counters VALUES ($org, $type, $year, 1)
//   ON CONFLICT (organisation_id, doc_type, year)
//   DO UPDATE SET last_number = document_counters.last_number + 1
//   RETURNING last_number;
// Format: {PREFIX}-{year}-{number padded to 5} → GRN-2026-00001.
export const documentCounters = pgTable(
  'document_counters',
  {
    organisationId: text('organisation_id')
      .notNull()
      .references(() => organization.id),
    docType: docType('doc_type').notNull(),
    year: integer('year').notNull(),
    lastNumber: integer('last_number').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.organisationId, t.docType, t.year] }),
  ],
);

export const documents = pgTable(
  'documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organisationId: text('organisation_id')
      .notNull()
      .references(() => organization.id),
    type: docType('type').notNull(),
    number: text('number'),
    refType: docType('ref_type'),
    refId: uuid('ref_id'),
    storageKey: text('storage_key').notNull(),
    mime: text('mime').notNull().default('application/pdf'),
    sizeBytes: integer('size_bytes'),
    createdBy: text('created_by').references(() => user.id),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('documents_org_ref_idx').on(t.organisationId, t.refType, t.refId),
  ],
);

// user_id null = notification for all org users.
export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organisationId: text('organisation_id')
      .notNull()
      .references(() => organization.id),
    userId: text('user_id').references(() => user.id),
    type: notificationType('type').notNull(),
    title: text('title').notNull(),
    body: text('body'),
    link: text('link'),
    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('notifications_org_user_read_idx').on(
      t.organisationId,
      t.userId,
      t.readAt,
    ),
  ],
);

// Append-only.
export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organisationId: text('organisation_id')
      .notNull()
      .references(() => organization.id),
    userId: text('user_id').references(() => user.id),
    action: auditAction('action').notNull(),
    tableName: text('table_name').notNull(),
    recordId: text('record_id').notNull(),
    before: jsonb('before'),
    after: jsonb('after'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('audit_log_org_record_idx').on(
      t.organisationId,
      t.tableName,
      t.recordId,
    ),
    index('audit_log_org_created_idx').on(t.organisationId, t.createdAt),
  ],
);
