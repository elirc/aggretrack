import { z } from "zod";

import type { DbOrTx } from "@/db/client";
import type { OrgContext } from "@/lib/authz/context";
import { can, type Permission } from "@/lib/authz/permissions";
import { DomainError } from "@/lib/domain/errors";
import * as md from "@/lib/services/masterData";
import { createDispatch } from "@/lib/services/dispatches";
import { createPurchase } from "@/lib/services/purchases";
import { receivePurchase } from "@/lib/services/receiving";
import type { SellingDeps } from "@/lib/services/salesOrders";
import { listSupplierOptions, type PendingJob } from "@/lib/services/suppliers";
import { purchaseCreateInput, receivePurchaseInput } from "@/lib/validation/buying";
import { zUuid } from "@/lib/validation/common";
import { dispatchInput } from "@/lib/validation/selling";

/**
 * Offline outbox ingest (P4-B, ARCHITECTURE §Offline / PWA).
 *
 * Each op is validated with the SAME zod schema the online server action uses
 * and runs through the SAME service, in its OWN transaction (the services open
 * one each), strictly in order — so a purchase and its receipt can travel in
 * one batch, and one failing op never blocks the rest.
 *
 * Idempotency (DECISIONS #11): the client uuid is the PK.
 *  - purchase: createPurchase(id = clientId) → duplicate flag.
 *  - receipt: receivePurchase on an already-received purchase throws
 *    ALREADY_RECEIVED → reported as `duplicate` (stock untouched).
 *  - dispatch: createDispatch(clientId) → duplicate flag; CONFLICT (id used by
 *    another org) → error.
 * Jobs a service returns are enqueued only AFTER that op's tx has committed.
 *
 * Guard parity with orgAction: read-only orgs get READ_ONLY per op, and each
 * kind checks its permission (purchase.create / purchase.receive /
 * dispatch.write).
 */

export const SYNC_KINDS = ["purchase", "receipt", "dispatch"] as const;
export type SyncKind = (typeof SYNC_KINDS)[number];

export const SYNC_MAX_OPS = 50;

const PERMISSION: Record<SyncKind, Permission> = {
  purchase: "purchase.create",
  receipt: "purchase.receive",
  dispatch: "dispatch.write",
};

export const syncOpSchema = z.object({
  clientId: zUuid,
  kind: z.enum(SYNC_KINDS),
  payload: z.unknown(),
  /** Org the op was queued under (client-side snapshot). Mismatch → ORG_MISMATCH. */
  orgId: z.string().nullish(),
});
export type SyncOp = z.output<typeof syncOpSchema>;

export const syncRequestSchema = z.object({
  ops: z.array(z.unknown()).max(SYNC_MAX_OPS),
});

export type SyncOpResult =
  | { clientId: string; status: "applied" | "duplicate"; ref?: { id: string; number: string | null } }
  | { clientId: string; status: "error"; code: string; message: string };

export type SyncResponse = { orgId: string; results: SyncOpResult[] };

export type SyncDeps = {
  /** Post-commit job enqueue (prod: enqueuePendingJobs). */
  enqueueJobs?: (jobs: PendingJob[]) => Promise<void>;
  /** Passed to createDispatch (its waybill PDF is enqueued post-commit inside the service). */
  selling?: SellingDeps;
};

function clientIdOf(raw: unknown, index: number): string {
  if (raw && typeof raw === "object" && typeof (raw as { clientId?: unknown }).clientId === "string") {
    return (raw as { clientId: string }).clientId;
  }
  return `#${index}`;
}

function asObject(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function zodMessage(err: z.ZodError): string {
  return err.issues
    .slice(0, 5)
    .map((i) => `${i.path.join(".") || "payload"}: ${i.message}`)
    .join("; ");
}

async function applyOp(db: DbOrTx, ctx: OrgContext, op: SyncOp, deps: SyncDeps): Promise<SyncOpResult> {
  const { clientId } = op;
  const payload = asObject(op.payload);

  switch (op.kind) {
    case "purchase": {
      const parsed = purchaseCreateInput.safeParse({ ...payload, id: clientId, createdOffline: true });
      if (!parsed.success) return { clientId, status: "error", code: "VALIDATION", message: zodMessage(parsed.error) };
      const { purchase, duplicate } = await createPurchase(db, ctx, parsed.data);
      return {
        clientId,
        status: duplicate ? "duplicate" : "applied",
        ref: { id: purchase.id, number: purchase.purchaseNumber },
      };
    }
    case "receipt": {
      const parsed = receivePurchaseInput.safeParse(payload);
      if (!parsed.success) return { clientId, status: "error", code: "VALIDATION", message: zodMessage(parsed.error) };
      try {
        const res = await receivePurchase(db, ctx, parsed.data);
        // receivePurchase has committed by now → safe to enqueue (GRN PDF, SMS).
        if (deps.enqueueJobs) await deps.enqueueJobs(res.jobs);
        return { clientId, status: "applied", ref: { id: res.purchaseId, number: res.grnNumber } };
      } catch (err) {
        if (err instanceof DomainError && err.code === "ALREADY_RECEIVED") {
          return { clientId, status: "duplicate", ref: { id: parsed.data.purchaseId, number: null } };
        }
        throw err;
      }
    }
    case "dispatch": {
      const parsed = dispatchInput.safeParse({ ...payload, clientId });
      if (!parsed.success) return { clientId, status: "error", code: "VALIDATION", message: zodMessage(parsed.error) };
      const res = await createDispatch(db, ctx, parsed.data, deps.selling);
      return {
        clientId,
        status: res.duplicate ? "duplicate" : "applied",
        ref: { id: res.dispatch.id, number: res.dispatch.waybillNumber },
      };
    }
  }
}

/** Apply a batch of outbox ops in order; never throws for a single op's failure. */
export async function processSyncBatch(
  db: DbOrTx,
  ctx: OrgContext,
  rawOps: unknown[],
  deps: SyncDeps = {},
): Promise<SyncResponse> {
  const results: SyncOpResult[] = [];
  for (let i = 0; i < rawOps.length; i++) {
    const raw = rawOps[i];
    const parsed = syncOpSchema.safeParse(raw);
    if (!parsed.success) {
      results.push({ clientId: clientIdOf(raw, i), status: "error", code: "VALIDATION", message: zodMessage(parsed.error) });
      continue;
    }
    const op = parsed.data;
    if (op.orgId && op.orgId !== ctx.orgId) {
      results.push({
        clientId: op.clientId,
        status: "error",
        code: "ORG_MISMATCH",
        message: "Queued under another organisation — switch back to it to sync",
      });
      continue;
    }
    if (!can(ctx.role, PERMISSION[op.kind])) {
      results.push({ clientId: op.clientId, status: "error", code: "FORBIDDEN", message: `Role ${ctx.role} lacks ${PERMISSION[op.kind]}` });
      continue;
    }
    if (ctx.readOnly) {
      results.push({ clientId: op.clientId, status: "error", code: "READ_ONLY", message: "Organisation is read only" });
      continue;
    }
    try {
      results.push(await applyOp(db, ctx, op, deps));
    } catch (err) {
      if (err instanceof DomainError) {
        results.push({ clientId: op.clientId, status: "error", code: err.code, message: err.message });
      } else {
        console.error("[sync] op failed", op.kind, op.clientId, err);
        results.push({ clientId: op.clientId, status: "error", code: "INTERNAL", message: "Unexpected server error" });
      }
    }
  }
  return { orgId: ctx.orgId, results };
}

// ── reference data for the offline forms ────────────────────────────────────

export type RefData = {
  orgId: string;
  fetchedAt: string;
  suppliers: Array<{ id: string; name: string; phone: string | null; village: string | null }>;
  commodities: Array<{ id: string; name: string }>;
  grades: Array<{ id: string; name: string; commodityId: string }>;
  bagTypes: Array<{ id: string; name: string; standardKg: string; sackWeightKg: string }>;
  buyingPoints: Array<{ id: string; name: string }>;
  warehouses: Array<{ id: string; name: string; bins: Array<{ id: string; name: string }> }>;
};

/** Org-scoped reference lists cached client-side (Dexie refData) for offline entry. */
export async function loadRefData(db: DbOrTx, ctx: OrgContext): Promise<RefData> {
  const [suppliers, commodities, grades, bagTypes, buyingPoints, warehouses] = await Promise.all([
    can(ctx.role, "supplier.read") ? listSupplierOptions(db, ctx) : Promise.resolve([]),
    md.listCommodities(db, ctx),
    md.listGrades(db, ctx),
    md.listBagTypes(db, ctx),
    md.listBuyingPoints(db, ctx),
    md.listWarehouses(db, ctx),
  ]);
  const bpAllowed = ctx.restrictions.buyingPointIds;
  const whAllowed = ctx.restrictions.warehouseIds;
  return {
    orgId: ctx.orgId,
    fetchedAt: new Date().toISOString(),
    suppliers: suppliers.map((s) => ({ id: s.id, name: s.name, phone: s.phone, village: s.village })),
    commodities: commodities.map((c) => ({ id: c.id, name: c.name })),
    grades: grades.map((g) => ({ id: g.id, name: g.name, commodityId: g.commodityId })),
    bagTypes: bagTypes.map((b) => ({ id: b.id, name: b.name, standardKg: b.standardKg, sackWeightKg: b.sackWeightKg })),
    buyingPoints: buyingPoints
      .filter((b) => bpAllowed === null || bpAllowed.includes(b.id))
      .map((b) => ({ id: b.id, name: b.name })),
    warehouses: warehouses
      .filter((w) => whAllowed === null || whAllowed.includes(w.id))
      .map((w) => ({ id: w.id, name: w.name, bins: w.bins.map((b) => ({ id: b.id, name: b.name })) })),
  };
}
