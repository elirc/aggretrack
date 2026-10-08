/**
 * billing.sweep (cron daily):
 *  - expired trials (status 'trialing' AND trial_ends_at < now): status stays
 *    'trialing' — read-only is DERIVED in the guard — but each org owner gets
 *    a notification (once while unread).
 *  - past_due subscriptions: each org owner gets a notification.
 * Paystack webhooks own status transitions; this sweep only informs.
 */
import type { Job } from "pg-boss";
import { and, eq, lt } from "drizzle-orm";

import { db, type DbOrTx } from "../../src/db/client";
import { member, subscriptions } from "../../src/db/schema";
import type { BillingSweepJob } from "../../src/lib/jobs";
import { notifyOnce } from "./alerts";

const TRIAL_LINK = "/settings/billing?reason=trial_expired";
const PAST_DUE_LINK = "/settings/billing?reason=past_due";

async function ownerIds(dbx: DbOrTx, orgId: string): Promise<string[]> {
  const rows = await dbx
    .select({ userId: member.userId })
    .from(member)
    .where(and(eq(member.organizationId, orgId), eq(member.role, "owner")));
  return rows.map((r) => r.userId);
}

/** Notify every owner; falls back to an org-wide notification when an org has no owner row. */
async function notifyOwners(
  dbx: DbOrTx,
  orgId: string,
  n: { title: string; body: string; link: string },
): Promise<number> {
  const owners = await ownerIds(dbx, orgId);
  const targets: (string | null)[] = owners.length ? owners : [null];
  let inserted = 0;
  for (const userId of targets) {
    if (await notifyOnce(dbx, { orgId, userId, type: "system", ...n })) inserted++;
  }
  return inserted;
}

export type BillingSweepResult = {
  expiredTrials: number;
  pastDue: number;
  notifications: number;
};

export async function runBillingSweep(dbx: DbOrTx = db, now: Date = new Date()): Promise<BillingSweepResult> {
  const result: BillingSweepResult = { expiredTrials: 0, pastDue: 0, notifications: 0 };

  const expired = await dbx
    .select({ orgId: subscriptions.organisationId, trialEndsAt: subscriptions.trialEndsAt })
    .from(subscriptions)
    .where(and(eq(subscriptions.status, "trialing"), lt(subscriptions.trialEndsAt, now)));
  for (const s of expired) {
    result.expiredTrials++;
    try {
      result.notifications += await notifyOwners(dbx, s.orgId, {
        title: "Your free trial has ended",
        body: "Your organisation is now read-only. Choose a plan to keep recording purchases, stock and sales.",
        link: TRIAL_LINK,
      });
    } catch (err) {
      console.error(`[billing] trial notification failed for org ${s.orgId}`, err);
    }
  }

  const pastDue = await dbx
    .select({ orgId: subscriptions.organisationId })
    .from(subscriptions)
    .where(eq(subscriptions.status, "past_due"));
  for (const s of pastDue) {
    result.pastDue++;
    try {
      result.notifications += await notifyOwners(dbx, s.orgId, {
        title: "Payment overdue",
        body: "Your last subscription payment failed. The organisation is read-only until payment succeeds.",
        link: PAST_DUE_LINK,
      });
    } catch (err) {
      console.error(`[billing] past-due notification failed for org ${s.orgId}`, err);
    }
  }

  return result;
}

export async function handleBillingSweep(jobs: Job<BillingSweepJob>[]): Promise<void> {
  if (!jobs.length) return;
  const r = await runBillingSweep();
  console.log(
    `[billing] ${r.expiredTrials} expired trial(s), ${r.pastDue} past-due, +${r.notifications} notification(s)`,
  );
}
