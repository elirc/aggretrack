import Link from "next/link";

import { AGE_BANDS, type AgeBand } from "@/lib/domain/ageing";
import type { Grams, Kobo } from "@/lib/domain/units";
import type { StockAgeing } from "@/lib/services/stockQueries";
import { cn } from "@/lib/utils";

import { fmtGrams, fmtNaira, formatLagosDate } from "./format";

/** Stock ageing bands per commodity, colour-coded fresh → old. Server-renderable. */

export const BAND_LABEL: Record<AgeBand, string> = {
  d0_30: "0–30 days",
  d31_60: "31–60 days",
  d61_90: "61–90 days",
  d90_plus: "Over 90 days",
};

const BAND_STYLE: Record<AgeBand, string> = {
  d0_30: "border-emerald-300 bg-emerald-50 text-emerald-950 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-50",
  d31_60: "border-lime-300 bg-lime-50 text-lime-950 dark:border-lime-800 dark:bg-lime-950 dark:text-lime-50",
  d61_90: "border-amber-300 bg-amber-50 text-amber-950 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-50",
  d90_plus: "border-red-300 bg-red-50 text-red-950 dark:border-red-800 dark:bg-red-950 dark:text-red-50",
};

const BAR_STYLE: Record<AgeBand, string> = {
  d0_30: "bg-emerald-500",
  d31_60: "bg-lime-500",
  d61_90: "bg-amber-500",
  d90_plus: "bg-red-500",
};

type Cell = { grams: Grams; valueKobo?: Kobo };
type Row = { commodityId: string; commodityName: string; total: Grams; bands: Record<AgeBand, Cell> };

function emptyBands(): Record<AgeBand, Cell> {
  return { d0_30: { grams: 0 }, d31_60: { grams: 0 }, d61_90: { grams: 0 }, d90_plus: { grams: 0 } };
}

function byCommodity(ageing: StockAgeing): Row[] {
  const map = new Map<string, Row>();
  for (const r of ageing.rows) {
    const row = map.get(r.commodityId) ?? {
      commodityId: r.commodityId,
      commodityName: r.commodityName,
      total: 0,
      bands: emptyBands(),
    };
    const cell = row.bands[r.band];
    cell.grams += r.grams;
    if (r.valueKobo !== undefined) cell.valueKobo = (cell.valueKobo ?? 0) + r.valueKobo;
    row.total += r.grams;
    map.set(r.commodityId, row);
  }
  return [...map.values()].sort((a, b) => a.commodityName.localeCompare(b.commodityName));
}

function BandTile({ band, cell }: { band: AgeBand; cell: Cell }) {
  return (
    <div className={cn("flex flex-col rounded-md border px-2.5 py-2", BAND_STYLE[band], cell.grams === 0 && "opacity-60")}>
      <span className="text-[11px] font-medium uppercase tracking-wide">{BAND_LABEL[band]}</span>
      <span className="font-semibold tabular-nums">{fmtGrams(cell.grams)}</span>
      {cell.valueKobo !== undefined ? <span className="text-xs tabular-nums">{fmtNaira(cell.valueKobo)}</span> : null}
    </div>
  );
}

function Bar({ bands, total }: { bands: Record<AgeBand, Cell>; total: Grams }) {
  if (total <= 0) return null;
  return (
    <div className="flex h-2 w-full overflow-hidden rounded-full bg-muted" aria-hidden>
      {AGE_BANDS.map((b) => (
        <div key={b} className={BAR_STYLE[b]} style={{ width: `${(bands[b].grams / total) * 100}%` }} />
      ))}
    </div>
  );
}

export function AgeingView({ ageing }: { ageing: StockAgeing }) {
  const rows = byCommodity(ageing);
  const totalBands = emptyBands();
  let total = 0;
  for (const b of AGE_BANDS) {
    totalBands[b] = { grams: ageing.bands[b].grams, valueKobo: ageing.bands[b].valueKobo };
    total += ageing.bands[b].grams;
  }
  const oldest = ageing.rows.filter((r) => r.band === "d90_plus").slice(0, 10);

  return (
    <div className="flex flex-col gap-4">
      <section className="flex flex-col gap-2 rounded-lg border bg-card p-3">
        <div className="flex items-baseline justify-between gap-2">
          <h2 className="font-medium">All commodities</h2>
          <span className="text-xs text-muted-foreground">as of {formatLagosDate(ageing.asOf)}</span>
        </div>
        <Bar bands={totalBands} total={total} />
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {AGE_BANDS.map((b) => (
            <BandTile key={b} band={b} cell={totalBands[b]} />
          ))}
        </div>
      </section>

      {rows.map((r) => (
        <section key={r.commodityId} className="flex flex-col gap-2 rounded-lg border bg-card p-3">
          <div className="flex items-baseline justify-between gap-2">
            <h2 className="font-medium">{r.commodityName}</h2>
            <span className="text-sm tabular-nums text-muted-foreground">{fmtGrams(r.total)}</span>
          </div>
          <Bar bands={r.bands} total={r.total} />
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {AGE_BANDS.map((b) => (
              <BandTile key={b} band={b} cell={r.bands[b]} />
            ))}
          </div>
        </section>
      ))}

      {oldest.length > 0 ? (
        <section className="flex flex-col gap-2">
          <h2 className="font-medium">Oldest lots (over 90 days)</h2>
          <ul className="flex flex-col divide-y rounded-lg border">
            {oldest.map((r) => (
              <li key={`${r.lotId}-${r.warehouseId}`}>
                <Link
                  href={`/stock/lots/${r.lotId}`}
                  className="flex min-h-12 flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm hover:bg-accent/50"
                >
                  <span className="flex flex-col">
                    <span className="font-mono">{r.lotNumber}</span>
                    <span className="text-xs text-muted-foreground">
                      {r.commodityName} {r.gradeName} · {r.warehouseName}
                    </span>
                  </span>
                  <span className="text-right">
                    <span className="block font-medium tabular-nums">{fmtGrams(r.grams)}</span>
                    <span className="text-xs text-red-700 dark:text-red-400">{r.ageDays} days</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
