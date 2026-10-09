/**
 * Seed phase 3: verify the seeded org and print a summary with PASS/FAIL per
 * check. Returns false when any check fails (seed.ts then exits non-zero).
 */
import { sql } from "drizzle-orm";

import type { Db } from "../../src/db/client";
import type { OrgContext } from "../../src/lib/authz/context";
import { kgToGrams } from "../../src/lib/domain/units";
import { marginBySale, marginTotals } from "../../src/lib/services/margin";
import { payablesAgeing } from "../../src/lib/services/payables";
import { receivablesAgeing } from "../../src/lib/services/receivables";
import { getStockPosition } from "../../src/lib/services/stockQueries";

import type { Master } from "./setup";

type Row = Record<string, unknown>;

async function rows(db: Db, q: ReturnType<typeof sql>): Promise<Row[]> {
  const res = (await db.execute(q)) as unknown as { rows?: Row[] };
  return res.rows ?? [];
}

async function scalar(db: Db, q: ReturnType<typeof sql>): Promise<number> {
  const [r] = await rows(db, q);
  return Number(Object.values(r ?? { v: 0 })[0] ?? 0);
}

const naira = (kobo: number) => `₦${(kobo / 100).toLocaleString("en-NG", { maximumFractionDigits: 0 })}`;

export async function verifySeed(db: Db, owner: OrgContext, m: Master, freshDb: boolean): Promise<boolean> {
  const org = owner.orgId;
  const results: Array<{ ok: boolean; name: string; detail: string }> = [];
  const check = (name: string, ok: boolean, detail: string) => results.push({ ok, name, detail });

  // ── counts ──────────────────────────────────────────────────────────────
  const c = {
    usersTotal: await scalar(db, sql`select count(*) from "user"`),
    members: await scalar(db, sql`select count(*) from member where organization_id = ${org}`),
    platformAdmins: await scalar(
      db,
      sql`select count(*) from "user" u where u.is_platform_admin and not exists (select 1 from member mb where mb.user_id = u.id)`,
    ),
    suppliers: await scalar(db, sql`select count(*) from suppliers where organisation_id = ${org}`),
    customers: await scalar(db, sql`select count(*) from customers where organisation_id = ${org}`),
    commodities: await scalar(db, sql`select count(*) from commodities where organisation_id = ${org}`),
    warehouses: await scalar(db, sql`select count(*) from warehouses where organisation_id = ${org}`),
    priceGuides: await scalar(db, sql`select count(*) from price_guides where organisation_id = ${org}`),
    purchases: await scalar(db, sql`select count(*) from purchases where organisation_id = ${org}`),
    purchasesReceived: await scalar(db, sql`select count(*) from purchases where organisation_id = ${org} and status = 'received'`),
    purchasesPending: await scalar(db, sql`select count(*) from purchases where organisation_id = ${org} and status = 'pending_approval'`),
    purchasesApprovedUnreceived: await scalar(db, sql`select count(*) from purchases where organisation_id = ${org} and status = 'approved'`),
    receivedLines: await scalar(
      db,
      sql`select count(*) from purchase_lines pl join purchases p on p.id = pl.purchase_id where p.organisation_id = ${org} and p.status = 'received'`,
    ),
    lots: await scalar(db, sql`select count(*) from lots where organisation_id = ${org}`),
    movements: await scalar(db, sql`select count(*) from stock_movements where organisation_id = ${org}`),
    salesOrders: await scalar(db, sql`select count(*) from sales_orders where organisation_id = ${org}`),
    ordersConfirmed: await scalar(db, sql`select count(*) from sales_orders where organisation_id = ${org} and status = 'confirmed'`),
    ordersAllocated: await scalar(db, sql`select count(*) from sales_orders where organisation_id = ${org} and status = 'allocated'`),
    dispatches: await scalar(db, sql`select count(*) from dispatches where organisation_id = ${org}`),
    dispatchesInTransit: await scalar(db, sql`select count(*) from dispatches where organisation_id = ${org} and status = 'in_transit'`),
    invoices: await scalar(db, sql`select count(*) from invoices where organisation_id = ${org}`),
    invoicesPaid: await scalar(db, sql`select count(*) from invoices where organisation_id = ${org} and status = 'paid'`),
    customerPayments: await scalar(db, sql`select count(*) from customer_payments where organisation_id = ${org}`),
    supplierPayments: await scalar(db, sql`select count(*) from supplier_payments where organisation_id = ${org}`),
    advances: await scalar(db, sql`select count(*) from supplier_advances where organisation_id = ${org}`),
    advanceOffsets: await scalar(db, sql`select count(*) from supplier_advance_offsets where organisation_id = ${org}`),
    tripsInbound: await scalar(db, sql`select count(*) from trips where organisation_id = ${org} and direction = 'inbound'`),
    tripsOutbound: await scalar(db, sql`select count(*) from trips where organisation_id = ${org} and direction = 'outbound'`),
    expenses: await scalar(db, sql`select count(*) from expenses where organisation_id = ${org}`),
    transfers: await scalar(db, sql`select count(*) from transfers where organisation_id = ${org}`),
    transfersInTransit: await scalar(db, sql`select count(*) from transfers where organisation_id = ${org} and status = 'in_transit'`),
    counts: await scalar(db, sql`select count(*) from stock_counts where organisation_id = ${org}`),
    adjustments: await scalar(db, sql`select count(*) from adjustments where organisation_id = ${org}`),
    adjustmentsPending: await scalar(db, sql`select count(*) from adjustments where organisation_id = ${org} and status = 'pending_approval'`),
    lotsWithLandedUplift: await scalar(
      db,
      sql`select count(*) from lots where organisation_id = ${org} and landed_cost_per_kg_kobo > purchase_price_per_kg_kobo`,
    ),
  };

  console.log("\n── Seed summary ─────────────────────────────────────────");
  for (const [k, v] of Object.entries(c)) console.log(`  ${k.padEnd(28)} ${v}`);

  // ── identity + parties ────────────────────────────────────────────────────
  check("users = 7 (6 roles + platform admin)", freshDb ? c.usersTotal === 7 : c.members === 6, `users=${c.usersTotal} members=${c.members}`);
  check("one membership per role", c.members === 6, `members=${c.members}`);
  check("platform admin without membership", c.platformAdmins >= 1, `platformAdmins=${c.platformAdmins}`);
  check("40 suppliers", c.suppliers === 40, String(c.suppliers));
  check("8 customers", c.customers === 8, String(c.customers));
  check("2 warehouses, 7 commodities", c.warehouses === 2 && c.commodities === 7, `wh=${c.warehouses} com=${c.commodities}`);

  // ── buying ──────────────────────────────────────────────────────────────
  check("≥110 purchases received", c.purchasesReceived >= 110, `${c.purchasesReceived}/${c.purchases}`);
  check("lots = lines of received purchases", c.lots === c.receivedLines, `lots=${c.lots} lines=${c.receivedLines}`);
  check("≥1 purchase pending approval", c.purchasesPending >= 1, String(c.purchasesPending));
  const badLotDates = await scalar(
    db,
    sql`select count(*) from lots l
        join purchase_lines pl on pl.id = l.purchase_line_id
        join purchases p on p.id = pl.purchase_id
        where l.organisation_id = ${org}
          and ((l.received_at at time zone 'Africa/Lagos')::date < p.purchase_date
            or (l.received_at at time zone 'Africa/Lagos')::date > p.purchase_date + 2)`,
  );
  check("lot received date = purchase date + 0..2 days", badLotDates === 0, `violations=${badLotDates}`);
  const futureMoves = await scalar(db, sql`select count(*) from stock_movements where organisation_id = ${org} and occurred_at > now()`);
  check("no movement dated in the future", futureMoves === 0, `future=${futureMoves}`);
  check("trips raised landed cost on some lots", c.lotsWithLandedUplift > 0, String(c.lotsWithLandedUplift));

  // ── stock invariants ──────────────────────────────────────────────────────
  const negPairs = await scalar(
    db,
    sql`select count(*) from (select lot_id, warehouse_id, sum(kg) s from stock_movements where organisation_id = ${org} group by 1, 2) x where s < 0`,
  );
  check("every lot×warehouse on hand = SUM(movements) ≥ 0", negPairs === 0, `negative pairs=${negPairs}`);
  const overOriginal = await scalar(
    db,
    sql`select count(*) from lots l where l.organisation_id = ${org}
        and coalesce((select sum(m.kg) from stock_movements m where m.lot_id = l.id), 0) > l.original_kg`,
  );
  check("no lot holds more than it was received with", overOriginal === 0, `violations=${overOriginal}`);
  const overReserved = await scalar(
    db,
    sql`select count(*) from (
          select a.lot_id, a.warehouse_id, sum(a.kg) r,
            coalesce((select sum(m.kg) from stock_movements m where m.lot_id = a.lot_id and m.warehouse_id = a.warehouse_id), 0) oh
          from lot_allocations a where a.organisation_id = ${org} and a.status = 'reserved' group by 1, 2) x
        where r > oh`,
  );
  check("reservations ≤ on hand", overReserved === 0, `violations=${overReserved}`);

  for (const key of ["main", "billiri"] as const) {
    const wh = m.warehouses[key];
    const pos = await getStockPosition(db, owner, { warehouseId: wh.id });
    const sumG = kgToGrams(
      String(
        (await rows(db, sql`select coalesce(sum(kg), 0)::text s from stock_movements where organisation_id = ${org} and warehouse_id = ${wh.id}`))[0]
          ?.s ?? "0",
      ),
    );
    let lotRowsG = 0;
    for (const com of pos.commodities) for (const g of com.grades) for (const w of g.warehouses) for (const l of w.lots) lotRowsG += l.grams;
    check(
      `stock position > 0 and = SUM(movements) in ${wh.name}`,
      pos.totals.grams > 0 && pos.totals.grams === sumG && lotRowsG === sumG,
      `position=${pos.totals.kg}kg sum=${sumG / 1000}kg value=${naira(pos.totals.valueKobo ?? 0)}`,
    );
  }

  // ── warehouse flows ─────────────────────────────────────────────────────
  check("≥1 transfer in transit", c.transfersInTransit >= 1, `${c.transfersInTransit}/${c.transfers}`);
  check("3 stock counts", c.counts === 3, String(c.counts));
  check("≥1 adjustment pending approval", c.adjustmentsPending >= 1, `${c.adjustmentsPending}/${c.adjustments}`);

  // ── selling ─────────────────────────────────────────────────────────────
  check("≈60 sales orders", c.salesOrders >= 55, String(c.salesOrders));
  check("orders left confirmed + allocated for UI variety", c.ordersConfirmed >= 1 && c.ordersAllocated >= 1, `confirmed=${c.ordersConfirmed} allocated=${c.ordersAllocated}`);
  check("≥1 dispatch still in transit", c.dispatchesInTransit >= 1, `${c.dispatchesInTransit}/${c.dispatches}`);
  check("invoices issued and some fully paid", c.invoices >= 40 && c.invoicesPaid >= 20, `invoices=${c.invoices} paid=${c.invoicesPaid}`);

  // ── money ───────────────────────────────────────────────────────────────
  const pay = await payablesAgeing(db, owner, {});
  const payBands = Object.entries(pay.totals.bands).filter(([, v]) => v > 0);
  check(
    "payables non-zero in ≥2 ageing bands",
    pay.totals.totalKobo > 0 && payBands.length >= 2,
    `${naira(pay.totals.totalKobo)} ${payBands.map(([b, v]) => `${b}=${naira(v)}`).join(" ")}`,
  );
  const rec = await receivablesAgeing(db, owner, {});
  const recBands = (["d0_30", "d31_60", "d61_90", "d90_plus"] as const).filter((b) => rec.totals[b] > 0);
  check(
    "receivables non-zero in ≥2 ageing bands",
    rec.totals.total > 0 && recBands.length >= 2,
    `${naira(rec.totals.total)} ${recBands.map((b) => `${b}=${naira(rec.totals[b])}`).join(" ")}`,
  );
  check("supplier advances + offsets", c.advances === 10 && c.advanceOffsets >= 1, `advances=${c.advances} offsets=${c.advanceOffsets}`);
  check("inbound + outbound trips", c.tripsInbound >= 8 && c.tripsOutbound >= 6, `in=${c.tripsInbound} out=${c.tripsOutbound}`);

  const bySale = await marginBySale(db, owner, {});
  const tot = await marginTotals(db, owner, {});
  check(
    "margin report non-empty",
    bySale.length > 0 && tot.revenueKobo > 0,
    `sales=${bySale.length} revenue=${naira(tot.revenueKobo)} cost=${naira(tot.costKobo)} margin=${naira(tot.marginKobo)} (${tot.marginPercent.toFixed(1)}%)`,
  );

  console.log("\n── Checks ───────────────────────────────────────────────");
  for (const r of results) console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.name.padEnd(52)} ${r.detail}`);
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n  ${results.length - failed}/${results.length} checks passed`);
  return failed === 0;
}
