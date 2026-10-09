"use client";

import { useEffect, useRef, useState } from "react";

import { lookupPriceGuideAction } from "@/actions/price-guides";

export type GuideKey = {
  commodityId: string;
  gradeId: string;
  buyingPointId: string;
  date: string;
};

/** undefined = still loading; null = no guide applies. */
export type GuideState = { maxPricePerKgKobo: number; guideDate: string } | null | undefined;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function guideKeyString(k: GuideKey): string {
  return `${k.commodityId}|${k.gradeId}|${k.buyingPointId}|${k.date}`;
}

function lookupable(k: GuideKey): boolean {
  return UUID_RE.test(k.commodityId) && UUID_RE.test(k.gradeId) && DATE_RE.test(k.date);
}

/**
 * Fetch (and cache) the applicable price guide for each commodity/grade/point/
 * date combination via the lookup server action. Re-fetches only for new
 * combinations, so typing weights/prices never triggers a request.
 */
export function usePriceGuides(keys: GuideKey[]): (k: GuideKey) => GuideState {
  const [cache, setCache] = useState<Record<string, GuideState>>({});
  const requested = useRef(new Set<string>());
  const wanted = keys.filter(lookupable);
  const signature = [...new Set(wanted.map(guideKeyString))].sort().join(",");

  useEffect(() => {
    if (!signature) return;
    for (const ks of signature.split(",")) {
      if (requested.current.has(ks)) continue;
      requested.current.add(ks);
      const [commodityId, gradeId, buyingPointId, date] = ks.split("|");
      void (async () => {
        let value: GuideState = null;
        try {
          const res = await lookupPriceGuideAction({
            commodityId,
            gradeId: gradeId || null,
            buyingPointId: buyingPointId || null,
            date,
          });
          value = res.ok && res.data ? { maxPricePerKgKobo: res.data.maxPricePerKgKobo, guideDate: res.data.guideDate } : null;
          if (!res.ok) requested.current.delete(ks); // allow a retry later (e.g. offline)
        } catch {
          requested.current.delete(ks);
          value = null;
        }
        // Results are cached even if the signature moved on — the same
        // combination is likely to come back (e.g. switching grades).
        setCache((prev) => ({ ...prev, [ks]: value }));
      })();
    }
  }, [signature]);

  return (k: GuideKey) => {
    if (!lookupable(k)) return null;
    const ks = guideKeyString(k);
    return ks in cache ? cache[ks] : undefined;
  };
}
