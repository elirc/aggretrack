import { and, asc, count, desc, eq, inArray, sql, type SQL } from "drizzle-orm";

import type { DbOrTx } from "@/db/client";
import { lots, transferLines, transfers } from "@/db/schema";
import type { OrgContext } from "@/lib/authz/context";
import { writeAudit } from "@/lib/audit/audit";
import { DomainError } from "@/lib/domain/errors";
import { gramsToKg, kgToGrams } from "@/lib/domain/units";
import { nextDocNumber } from "@/lib/services/numbering";
import { postMovements, type MovementInput } from "@/lib/services/stockCore";
import {
  assertBinInWarehouse,
  assertWarehouseAccess,
  inTx,
  ownWarehouse,
} from "@/lib/services/stockQueries";
import type {
  CreateTransferInput,
  ListTransfersInput,
  ReceiveTransferInput,
  TransferIdInput,
} from "@/lib/validation/warehouse";

/**
 * Inter-warehouse transfers (DOMAIN-ENGINE §6).
 *
 * draft → in_transit (dispatch: transfer_out −kg at source) → received
 * (transfer_in +received_kg at destination; loss_kg = kg − received_kg on the
 * line, no extra movement — out − in nets the loss out of global stock).
 * draft → cancelled. All stock writes go through stockCore.postMovements,
 * which locks the lots (ORDER BY id FOR UPDATE) and enforces the floor.
 */

export type Transfer = typeof transfers.$inferSelect;
export type TransferLine = typeof transferLines.$inferSelect;
export type TransferWithLines = Transfer & { lines: TransferLine[] };

async function lockTransfer(tx: DbOrTx, ctx: OrgContext, id: string): Promise<Transfer> {
  const [row] = await tx
    .select()
    .from(transfers)
    .where(and(eq(transfers.organisationId, ctx.orgId), eq(transfers.id, id)))
    .for("update");
  if (!row) throw new DomainError("NOT_FOUND", "Transfer not found");
  return row;
}

async function linesOf(tx: DbOrTx, ctx: OrgContext, transferId: string): Promise<TransferLine[]> {
  return tx
    .select()
    .from(transferLines)
    .where(and(eq(transferLines.organisationId, ctx.orgId), eq(transferLines.transferId, transferId)))
    .orderBy(asc(transferLines.createdAt), asc(transferLines.id));
}

export async function createTransfer(
  db: DbOrTx,
  ctx: OrgContext,
  input: CreateTransferInput,
): Promise<TransferWithLines> {
  if (input.fromWarehouseId === input.toWarehouseId) {
    throw new DomainError("SAME_WAREHOUSE", "Source and destination must differ");
  }
  return inTx(db, async (tx) => {
    await ownWarehouse(tx, ctx, input.fromWarehouseId);
    await ownWarehouse(tx, ctx, input.toWarehouseId);
    assertWarehouseAccess(ctx, input.fromWarehouseId);

    const lotIds = [...new Set(input.lines.map((l) => l.lotId))];
    const found = await tx
      .select({ id: lots.id })
      .from(lots)
      .where(and(eq(lots.organisationId, ctx.orgId), inArray(lots.id, lotIds)));
    if (found.length !== lotIds.length) throw new DomainError("NOT_FOUND", "Lot not found");

    const transferNumber = await nextDocNumber(tx, ctx.orgId, "trf");
    const [t] = await tx
      .insert(transfers)
      .values({
        organisationId: ctx.orgId,
        transferNumber,
        fromWarehouseId: input.fromWarehouseId,
        toWarehouseId: input.toWarehouseId,
        status: "draft",
        createdBy: ctx.userId,
      })
      .returning();
    const lines = await tx
      .insert(transferLines)
      .values(
        input.lines.map((l) => ({
          transferId: t.id,
          organisationId: ctx.orgId,
          lotId: l.lotId,
          kg: gramsToKg(kgToGrams(l.kg)),
          bags: l.bags,
        })),
      )
      .returning();
    const out = { ...t, lines };
    await writeAudit(tx, ctx, { action: "create", tableName: "transfers", recordId: t.id, after: out });
    return out;
  });
}

export async function dispatchTransfer(
  db: DbOrTx,
  ctx: OrgContext,
  input: TransferIdInput,
): Promise<TransferWithLines> {
  return inTx(db, async (tx) => {
    const t = await lockTransfer(tx, ctx, input.transferId);
    assertWarehouseAccess(ctx, t.fromWarehouseId);
    if (t.status !== "draft") {
      throw new DomainError("INVALID_STATE", `Transfer is ${t.status}, only drafts can be dispatched`);
    }
    const lines = await linesOf(tx, ctx, t.id);
    if (lines.length === 0) throw new DomainError("INVALID_STATE", "Transfer has no lines");

    const now = new Date();
    const moves: MovementInput[] = lines.map((l) => ({
      lotId: l.lotId,
      warehouseId: t.fromWarehouseId,
      type: "transfer_out",
      grams: -kgToGrams(l.kg),
      bags: -l.bags,
      refType: "trf",
      refId: t.id,
      occurredAt: now,
    }));
    // Locks lots, checks available (on hand − reserved) at source, inserts.
    await postMovements(tx, ctx, moves);

    const [updated] = await tx
      .update(transfers)
      .set({ status: "in_transit", dispatchedAt: now, updatedAt: now })
      .where(and(eq(transfers.organisationId, ctx.orgId), eq(transfers.id, t.id)))
      .returning();
    await writeAudit(tx, ctx, {
      action: "update",
      tableName: "transfers",
      recordId: t.id,
      before: { status: t.status },
      after: { status: updated.status, dispatchedAt: updated.dispatchedAt },
    });
    return { ...updated, lines };
  });
}

export async function receiveTransfer(
  db: DbOrTx,
  ctx: OrgContext,
  input: ReceiveTransferInput,
): Promise<TransferWithLines> {
  return inTx(db, async (tx) => {
    const t = await lockTransfer(tx, ctx, input.transferId);
    assertWarehouseAccess(ctx, t.toWarehouseId);
    if (t.status !== "in_transit") {
      throw new DomainError("INVALID_STATE", `Transfer is ${t.status}, only in-transit transfers can be received`);
    }
    const lines = await linesOf(tx, ctx, t.id);
    const byId = new Map(lines.map((l) => [l.id, l]));
    const seen = new Set<string>();
    for (const r of input.lines) {
      if (!byId.has(r.lineId)) throw new DomainError("NOT_FOUND", "Transfer line not found");
      if (seen.has(r.lineId)) throw new DomainError("DUPLICATE_LINE", "Line entered twice");
      seen.add(r.lineId);
    }
    if (seen.size !== lines.length) {
      throw new DomainError("MISSING_LINES", "Enter a received weight for every line");
    }

    const now = new Date();
    const moves: MovementInput[] = [];
    const updates: { id: string; receivedKg: string; receivedBags: number; lossKg: string }[] = [];
    for (const r of input.lines) {
      const line = byId.get(r.lineId)!;
      const sentG = kgToGrams(line.kg);
      const recvG = kgToGrams(r.receivedKg);
      if (recvG > sentG) {
        throw new DomainError("RECEIVED_EXCEEDS_SENT", "Received weight is more than was sent", {
          lineId: line.id,
          sentG,
          recvG,
        });
      }
      let bags = r.receivedBags ?? (recvG === sentG ? line.bags : 0);
      if (bags > line.bags) {
        throw new DomainError("RECEIVED_EXCEEDS_SENT", "Received bags are more than were sent");
      }
      if (recvG === 0) bags = 0;
      if (r.binId) await assertBinInWarehouse(tx, ctx, r.binId, t.toWarehouseId);
      if (recvG > 0) {
        moves.push({
          lotId: line.lotId,
          warehouseId: t.toWarehouseId,
          binId: r.binId,
          type: "transfer_in",
          grams: recvG,
          bags,
          refType: "trf",
          refId: t.id,
          occurredAt: now,
        });
      }
      updates.push({
        id: line.id,
        receivedKg: gramsToKg(recvG),
        receivedBags: bags,
        lossKg: gramsToKg(sentG - recvG),
      });
    }

    await postMovements(tx, ctx, moves);
    for (const u of updates) {
      await tx
        .update(transferLines)
        .set({ receivedKg: u.receivedKg, receivedBags: u.receivedBags, lossKg: u.lossKg, updatedAt: now })
        .where(and(eq(transferLines.organisationId, ctx.orgId), eq(transferLines.id, u.id)));
    }
    const [updated] = await tx
      .update(transfers)
      .set({ status: "received", receivedAt: now, updatedAt: now })
      .where(and(eq(transfers.organisationId, ctx.orgId), eq(transfers.id, t.id)))
      .returning();
    const newLines = await linesOf(tx, ctx, t.id);
    await writeAudit(tx, ctx, {
      action: "update",
      tableName: "transfers",
      recordId: t.id,
      before: { status: t.status },
      after: { status: updated.status, receivedAt: updated.receivedAt, lines: updates },
    });
    return { ...updated, lines: newLines };
  });
}

export async function cancelTransfer(
  db: DbOrTx,
  ctx: OrgContext,
  input: TransferIdInput,
): Promise<Transfer> {
  return inTx(db, async (tx) => {
    const t = await lockTransfer(tx, ctx, input.transferId);
    assertWarehouseAccess(ctx, t.fromWarehouseId);
    if (t.status !== "draft") {
      throw new DomainError("INVALID_STATE", `Transfer is ${t.status}, only drafts can be cancelled`);
    }
    const [updated] = await tx
      .update(transfers)
      .set({ status: "cancelled", updatedAt: new Date() })
      .where(and(eq(transfers.organisationId, ctx.orgId), eq(transfers.id, t.id)))
      .returning();
    await writeAudit(tx, ctx, {
      action: "cancel",
      tableName: "transfers",
      recordId: t.id,
      before: { status: t.status },
      after: { status: updated.status },
    });
    return updated;
  });
}

export async function getTransfer(db: DbOrTx, ctx: OrgContext, id: string): Promise<TransferWithLines> {
  const [t] = await db
    .select()
    .from(transfers)
    .where(and(eq(transfers.organisationId, ctx.orgId), eq(transfers.id, id)))
    .limit(1);
  const allowed = ctx.restrictions.warehouseIds;
  if (!t || (allowed !== null && !allowed.includes(t.fromWarehouseId) && !allowed.includes(t.toWarehouseId))) {
    throw new DomainError("NOT_FOUND", "Transfer not found");
  }
  return { ...t, lines: await linesOf(db, ctx, t.id) };
}

export async function listTransfers(
  db: DbOrTx,
  ctx: OrgContext,
  q: Partial<ListTransfersInput> = {},
): Promise<{ rows: Transfer[]; total: number; page: number; pageSize: number }> {
  const page = q.page ?? 1;
  const pageSize = q.pageSize ?? 50;
  const where: SQL[] = [eq(transfers.organisationId, ctx.orgId)];
  if (q.status) where.push(eq(transfers.status, q.status));
  if (q.warehouseId) {
    where.push(sql`(${transfers.fromWarehouseId} = ${q.warehouseId} OR ${transfers.toWarehouseId} = ${q.warehouseId})`);
  }
  const allowed = ctx.restrictions.warehouseIds;
  if (allowed !== null) {
    const ids = allowed.length ? allowed : ["00000000-0000-0000-0000-000000000000"];
    where.push(sql`(${inArray(transfers.fromWarehouseId, ids)} OR ${inArray(transfers.toWarehouseId, ids)})`);
  }
  const cond = and(...where);
  const [{ n }] = await db.select({ n: count() }).from(transfers).where(cond);
  const rows = await db
    .select()
    .from(transfers)
    .where(cond)
    .orderBy(desc(transfers.createdAt), desc(transfers.transferNumber))
    .limit(pageSize)
    .offset((page - 1) * pageSize);
  return { rows, total: Number(n), page, pageSize };
}
