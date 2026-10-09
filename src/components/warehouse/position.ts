import type { StockPosition } from "@/lib/services/stockQueries";
import type { Grams } from "@/lib/domain/units";

/**
 * Lean lot options derived from the stock position drill-down, grouped by
 * warehouse. Used by the transfer lot picker, the count sheet and the manual
 * adjustment form. Carries no prices.
 */
export type LotOption = {
  lotId: string;
  lotNumber: string;
  commodityName: string;
  gradeName: string;
  receivedAt: Date;
  kg: string;
  grams: Grams;
  bags: number;
  bins: { binId: string | null; binName: string | null; kg: string; grams: Grams; bags: number }[];
};

export type LotsByWarehouse = Record<string, LotOption[]>;

export function lotsByWarehouse(position: StockPosition): LotsByWarehouse {
  const out: LotsByWarehouse = {};
  for (const c of position.commodities) {
    for (const g of c.grades) {
      for (const w of g.warehouses) {
        const list = (out[w.warehouseId] ??= []);
        for (const l of w.lots) {
          list.push({
            lotId: l.lotId,
            lotNumber: l.lotNumber,
            commodityName: c.commodityName,
            gradeName: g.gradeName,
            receivedAt: l.receivedAt,
            kg: l.kg,
            grams: l.grams,
            bags: l.bags,
            bins: l.bins.map((b) => ({ ...b })),
          });
        }
      }
    }
  }
  for (const list of Object.values(out)) {
    list.sort(
      (a, b) =>
        a.commodityName.localeCompare(b.commodityName) ||
        a.gradeName.localeCompare(b.gradeName) ||
        new Date(a.receivedAt).getTime() - new Date(b.receivedAt).getTime(),
    );
  }
  return out;
}

export function lotOptionLabel(l: Pick<LotOption, "lotNumber" | "commodityName" | "gradeName">): string {
  return `${l.lotNumber} · ${l.commodityName} ${l.gradeName}`;
}
