import {
  bigint,
  boolean,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { organization } from './auth';

export const subscriptionStatus = pgEnum('subscription_status', [
  'trialing',
  'active',
  'past_due',
  'cancelled',
]);

// Global catalogue — deliberately NO organisation_id.
export const plans = pgTable('plans', {
  id: uuid('id').primaryKey().defaultRandom(),
  code: text('code').notNull().unique(),
  name: text('name').notNull(),
  monthlyPriceKobo: bigint('monthly_price_kobo', { mode: 'number' }).notNull(),
  userLimit: integer('user_limit').notNull(),
  paystackPlanCode: text('paystack_plan_code'),
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// Read-only rule: org is read-only when status = 'past_due' or 'cancelled',
// or ('trialing' and trial_ends_at < now()). Enforced in the server-action
// guard, never by deletion.
export const subscriptions = pgTable('subscriptions', {
  id: uuid('id').primaryKey().defaultRandom(),
  organisationId: text('organisation_id')
    .notNull()
    .unique()
    .references(() => organization.id),
  planId: uuid('plan_id')
    .notNull()
    .references(() => plans.id),
  status: subscriptionStatus('status').notNull().default('trialing'),
  trialEndsAt: timestamp('trial_ends_at', { withTimezone: true }).notNull(),
  currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }),
  paystackCustomerCode: text('paystack_customer_code'),
  paystackSubscriptionCode: text('paystack_subscription_code'),
  paystackEmailToken: text('paystack_email_token'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});
