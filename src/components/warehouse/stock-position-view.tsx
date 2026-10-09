import Link from "next/link";
import { ChevronDown, ChevronRight } from "lucide-react";

import type { CommodityPositionNode, StockPosition, Totals } from "@/lib/services/stockQueries";

import { fmtBags, fmtGrams, fmtNaira, fmtRatePerKg, formatLagosDate } from "./format";

/**
 * Stock position drill-down: commodity accordion → grade rows → warehouse
 * chips → lots (with bins) linking to the lot page. Server-renderable
 * (native <details>). Value appears only when the server sent it.
 */

function TotalsLine({ t, strong }: { t: Totals; strong?: boolean }) {
  return (
    <span className={strong ? "font-semibold tabular-nums" : "tabular-nums"}>
      {fmtGrams(t.grams)}
      <span className="text-muted-foreground"> · {fmtBags(t.bags)}</span>
      {t.valueKobo !== undefined ? <span className="text-muted-foreground"> · {fmtNaira(t.valueKobo)}</span> : null}
    </span>
  );
}

function CommoditySection({ c, defaultOpen }: { c: CommodityPositionNode; defaultOpen: boolean }) {
  return (
    <details className="group rounded-lg border bg-card" open={defaultOpen}>
      <summary className="flex min-h-14 cursor-pointer list-none items-center gap-2 px-3 py-2 [&::-webkit-details-marker]:hidden">
        <ChevronRight className="size-4 shrink-0 transition-transform group-open:rotate-90" />
        <span className="flex-1 font-medium">{c.commodityName}</span>
        <span className="text-right text-sm">
          <TotalsLine t={c} strong />
        </span>
      </summary>
      <div className="flex flex-col gap-2 border-t px-3 py-3">
        {c.grades.map((g) => (
          <details key={g.gradeId} className="group/grade rounded-md border">
            <summary className="flex cursor-pointer list-none flex-col gap-2 px-3 py-2 [&::-webkit-details-marker]:hidden">
              <div className="flex items-center gap-2">
                <ChevronDown className="size-4 shrink-0 -rotate-90 transition-transform group-open/grade:rotate-0" />
                <span className="flex-1 text-sm font-medium">{g.gradeName}</span>
                <span className="text-right text-sm">
                  <TotalsLine t={g} />
                </span>
              </div>
              <div className="flex flex-wrap gap-1.5 pl-6">
                {g.warehouses.map((w) => (
                  <span
                    key={w.warehouseId}
                    className="inline-flex flex-wrap items-center gap-x-1 rounded-full border bg-muted/50 px-2.5 py-1 text-xs"
                  >
                    <span className="font-medium">{w.warehouseName}</span>
                    <span className="tabular-nums">{fmtGrams(w.grams)}</span>
                    <span className="text-muted-foreground">· {fmtBags(w.bags)}</span>
                    {w.valueKobo !== undefined ? (
                      <span className="text-muted-foreground">· {fmtNaira(w.valueKobo)}</span>
                    ) : null}
                  </span>
                ))}
              </div>
            </summary>
            <div className="flex flex-col gap-3 border-t px-3 py-3">
              {g.warehouses.map((w) => (
                <div key={w.warehouseId}>
                  <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    {w.warehouseName}
                  </p>
                  <ul className="flex flex-col divide-y rounded-md border">
                    {w.lots.map((l) => (
                      <li key={l.lotId}>
                        <Link
                          href={`/stock/lots/${l.lotId}`}
                          className="flex min-h-12 flex-col gap-0.5 px-3 py-2 hover:bg-accent/50"
                        >
                          <span className="flex items-center justify-between gap-2">
                            <span className="font-mono text-sm">{l.lotNumber}</span>
                            <span className="text-sm font-medium tabular-nums">{fmtGrams(l.grams)}</span>
                          </span>
                          <span className="flex flex-wrap justify-between gap-x-3 text-xs text-muted-foreground">
                            <span>Received {formatLagosDate(l.receivedAt)}</span>
                            <span>
                              {fmtBags(l.bags)}
                              {l.valueKobo !== undefined ? ` · ${fmtNaira(l.valueKobo)}` : ""}
                              {l.landedCostPerKgKobo !== undefined ? ` · ${fmtRatePerKg(l.landedCostPerKgKobo)}` : ""}
                            </span>
                          </span>
                          {l.bins.some((b) => b.binId) ? (
                            <span className="flex flex-wrap gap-1 pt-0.5">
                              {l.bins.map((b) => (
                                <span
                                  key={b.binId ?? "none"}
                                  className="rounded border px-1.5 py-0.5 text-[11px] text-muted-foreground"
                                >
                                  {b.binName ?? "No bin"} · {fmtGrams(b.grams)}
                                </span>
                              ))}
                            </span>
                          ) : null}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </details>
        ))}
      </div>
    </details>
  );
}

export function StockPositionView({ position }: { position: StockPosition }) {
  const t = position.totals;
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-2 rounded-lg border bg-card p-3 sm:grid-cols-3">
        <div>
          <p className="text-xs text-muted-foreground">On hand</p>
          <p className="text-lg font-semibold tabular-nums">{fmtGrams(t.grams)}</p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">Bags</p>
          <p className="text-lg font-semibold tabular-nums">{t.bags.toLocaleString("en-NG")}</p>
        </div>
        {t.valueKobo !== undefined ? (
          <div className="col-span-2 sm:col-span-1">
            <p className="text-xs text-muted-foreground">Value (landed)</p>
            <p className="text-lg font-semibold tabular-nums">{fmtNaira(t.valueKobo)}</p>
          </div>
        ) : null}
      </div>
      {position.commodities.map((c) => (
        <CommoditySection key={c.commodityId} c={c} defaultOpen={position.commodities.length === 1} />
      ))}
    </div>
  );
}
