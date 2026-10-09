import { z } from "zod";

import { parseNairaToKobo } from "@/components/buying/format";
import { calcLine, parseBags } from "@/components/buying/line-math";
import { deductionReasonEnum, type PurchaseCreateInput } from "@/lib/validation/buying";
import { zDateISO, zKgString, zUuid } from "@/lib/validation/common";

/**
 * UI-level schema for the purchase quick-entry form. Users type naira and kg
 * strings; `buildPurchasePayload` maps the parsed values onto the shared
 * `purchaseCreateInput` shape (src/lib/validation/buying.ts), which the server
 * action — and the offline sync route — parse again.
 */

export type DeductionRow = { reason: z.infer<typeof deductionReasonEnum>; kg: string };

export type LineValues = {
  /** Client-generated purchase line id (idempotent replays). */
  id: string;
  commodityId: string;
  gradeId: string;
  bagTypeId: string;
  bags: string;
  grossKg: string;
  moisturePercent: string;
  priceNaira: string;
  deductions: DeductionRow[];
};

export type PurchaseFormValues = {
  supplierId: string;
  buyingPointId: string;
  purchaseDate: string;
  lines: LineValues[];
};

export function buildPurchaseFormSchema(opts: {
  buyingPointRequired: boolean;
  sackWeightByBagType: ReadonlyMap<string, string>;
}) {
  const line = z
    .object({
      id: zUuid,
      commodityId: z.string().regex(/.+/, "Pick a commodity"),
      gradeId: z.string().regex(/.+/, "Pick a grade"),
      bagTypeId: z.string(),
      bags: z.string().refine((s) => parseBags(s) !== null, "Whole number of bags"),
      grossKg: z.string().trim().regex(/.+/, "Enter the gross weight").pipe(zKgString),
      moisturePercent: z
        .string()
        .trim()
        .refine((s) => s === "" || (/^\d{1,3}(\.\d{1,2})?$/.test(s) && Number(s) <= 100), "0–100, up to 2 decimals"),
      priceNaira: z.string().refine((s) => parseNairaToKobo(s) !== null, "Enter the price per kg in naira"),
      deductions: z.array(z.object({ reason: deductionReasonEnum, kg: zKgString })).max(10),
    })
    .superRefine((l, ctx) => {
      const calc = calcLine(l, opts.sackWeightByBagType);
      if (calc.error) ctx.addIssue({ code: "custom", path: ["grossKg"], message: calc.error });
    });

  return z.object({
    supplierId: z.string().refine((s) => zUuid.safeParse(s).success, "Pick a supplier"),
    buyingPointId: opts.buyingPointRequired
      ? z.string().refine((s) => zUuid.safeParse(s).success, "Pick your buying point")
      : z.string(),
    purchaseDate: zDateISO,
    lines: z.array(line).min(1, "Add at least one line").max(50),
  });
}

export function buildPurchasePayload(
  purchaseId: string,
  values: PurchaseFormValues,
  saveAsDraft: boolean,
): PurchaseCreateInput {
  return {
    id: purchaseId,
    supplierId: values.supplierId,
    buyingPointId: values.buyingPointId || null,
    purchaseDate: values.purchaseDate,
    saveAsDraft,
    createdOffline: false,
    clientCreatedAt: new Date().toISOString(),
    lines: values.lines.map((l) => ({
      id: l.id,
      commodityId: l.commodityId,
      gradeId: l.gradeId,
      bagTypeId: l.bagTypeId || null,
      bags: parseBags(l.bags) ?? 0,
      grossKg: l.grossKg.trim(),
      moisturePercent: l.moisturePercent.trim() || null,
      pricePerKgKobo: parseNairaToKobo(l.priceNaira) ?? 0,
      deductions: l.deductions.map((d) => ({ reason: d.reason, kg: d.kg.trim(), note: null })),
    })),
  };
}
