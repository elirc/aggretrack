import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "@/db/schema";
import { auditLog } from "@/db/schema";

export type AuditAction =
  | "create"
  | "update"
  | "cancel"
  | "approve"
  | "reject"
  | "post";

// Structurally satisfied by both the db singleton and a transaction.
// Orchestrator may swap for the canonical Tx export from @/db/client.
type DbLike = Pick<NodePgDatabase<typeof schema>, "insert">;

export interface AuditEntry {
  action: AuditAction;
  tableName: string;
  recordId: string;
  before?: unknown;
  after?: unknown;
}

/**
 * Write one audit row. Call inside the same transaction as the change it
 * records (spec: audit every create, update, cancel and approval with
 * before/after values).
 */
export async function writeAudit(
  tx: DbLike,
  ctx: { orgId: string; userId: string },
  entry: AuditEntry,
): Promise<void> {
  await tx.insert(auditLog).values({
    organisationId: ctx.orgId,
    userId: ctx.userId,
    action: entry.action,
    tableName: entry.tableName,
    recordId: entry.recordId,
    before: entry.before ?? null,
    after: entry.after ?? null,
  });
}
