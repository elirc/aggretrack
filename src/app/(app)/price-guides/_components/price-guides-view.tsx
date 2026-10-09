"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Controller, useForm, useWatch, type Resolver } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Pencil, Plus, Trash } from "lucide-react";
import { z } from "zod";

import { createPriceGuideAction, deletePriceGuideAction, updatePriceGuideAction } from "@/actions/price-guides";
import { runBuyingAction } from "@/components/buying/action-result";
import { displayDate, koboToNairaInput, lagosTodayISO, nairaPerKg, parseNairaToKobo } from "@/components/buying/format";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { zDateISO } from "@/lib/validation/common";

export type GuideRowView = {
  id: string;
  guideDate: string;
  commodityId: string;
  commodityName: string;
  gradeId: string | null;
  gradeName: string | null;
  buyingPointId: string | null;
  buyingPointName: string | null;
  maxPricePerKgKobo: number;
};

type Option = { id: string; name: string };
type GradeOption = Option & { commodityId: string };

const ANY = "__any__";
const priceField = z.string().refine((s) => (parseNairaToKobo(s) ?? 0) > 0, "Enter the maximum price per kg in naira");

const createSchema = z.object({
  commodityId: z.string().regex(/.+/, "Pick a commodity"),
  gradeId: z.string(),
  buyingPointId: z.string(),
  guideDate: zDateISO,
  maxPriceNaira: priceField,
});
type CreateValues = z.infer<typeof createSchema>;

const editSchema = z.object({ guideDate: zDateISO, maxPriceNaira: priceField });
type EditValues = z.infer<typeof editSchema>;

export function PriceGuidesView({
  rows,
  commodities,
  grades,
  buyingPoints,
  canWrite,
  defaultDate,
}: {
  rows: GuideRowView[];
  commodities: Option[];
  grades: GradeOption[];
  buyingPoints: Option[];
  canWrite: boolean;
  defaultDate?: string;
}) {
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<GuideRowView | null>(null);
  const [deleting, setDeleting] = useState<GuideRowView | null>(null);
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const byDate = new Map<string, GuideRowView[]>();
  for (const r of rows) {
    const list = byDate.get(r.guideDate) ?? [];
    list.push(r);
    byDate.set(r.guideDate, list);
  }

  return (
    <div className="flex flex-col gap-4">
      {canWrite ? (
        <Button className="h-12 w-full sm:h-9 sm:w-auto sm:self-start" onClick={() => setCreateOpen(true)} disabled={commodities.length === 0}>
          <Plus /> Set price guide
        </Button>
      ) : null}

      {rows.length === 0 ? (
        <div className="rounded-lg border border-dashed px-4 py-10 text-center">
          <p className="font-medium">No price guides for this selection</p>
          <p className="mt-1 text-sm text-muted-foreground">
            A guide sets the day&apos;s maximum buying price. Purchases above it need manager approval.
          </p>
        </div>
      ) : (
        [...byDate.entries()].map(([date, list]) => (
          <section key={date} className="flex flex-col gap-2">
            <h2 className="text-sm font-semibold text-muted-foreground">{displayDate(date)}</h2>
            <ul className="flex flex-col gap-2">
              {list.map((g) => (
                <li key={g.id}>
                  <Card className="py-3">
                    <CardContent className="flex items-center justify-between gap-3 px-3">
                      <div className="min-w-0">
                        <p className="truncate font-medium">
                          {g.commodityName} · {g.gradeName ?? "Any grade"}
                        </p>
                        <p className="truncate text-xs text-muted-foreground">{g.buyingPointName ?? "All buying points"}</p>
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        <span className="mr-1 font-semibold tabular-nums">{nairaPerKg(g.maxPricePerKgKobo)}</span>
                        {canWrite ? (
                          <>
                            <Button variant="ghost" size="icon-lg" aria-label="Edit guide" onClick={() => setEditing(g)}>
                              <Pencil />
                            </Button>
                            <Button variant="ghost" size="icon-lg" aria-label="Delete guide" onClick={() => setDeleting(g)}>
                              <Trash />
                            </Button>
                          </>
                        ) : null}
                      </div>
                    </CardContent>
                  </Card>
                </li>
              ))}
            </ul>
          </section>
        ))
      )}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Set price guide</DialogTitle>
            <DialogDescription>
              The most specific guide wins: grade + point, then grade, then point, then commodity-wide.
            </DialogDescription>
          </DialogHeader>
          {createOpen ? (
            <CreateGuideForm
              commodities={commodities}
              grades={grades}
              buyingPoints={buyingPoints}
              defaultDate={defaultDate ?? lagosTodayISO()}
              onDone={() => {
                setCreateOpen(false);
                router.refresh();
              }}
              onCancel={() => setCreateOpen(false)}
            />
          ) : null}
        </DialogContent>
      </Dialog>

      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="sm:max-w-md">
          {editing ? (
            <>
              <DialogHeader>
                <DialogTitle>Edit guide</DialogTitle>
                <DialogDescription>
                  {editing.commodityName} · {editing.gradeName ?? "Any grade"} · {editing.buyingPointName ?? "All buying points"}
                </DialogDescription>
              </DialogHeader>
              <EditGuideForm
                guide={editing}
                onDone={() => {
                  setEditing(null);
                  router.refresh();
                }}
                onCancel={() => setEditing(null)}
              />
            </>
          ) : null}
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this guide?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleting
                ? `${deleting.commodityName} · ${deleting.gradeName ?? "Any grade"} on ${displayDate(deleting.guideDate)}. Existing purchases are not changed.`
                : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Keep</AlertDialogCancel>
            <AlertDialogAction
              disabled={pending}
              onClick={(e) => {
                e.preventDefault();
                const target = deleting;
                if (!target) return;
                startTransition(async () => {
                  const res = await runBuyingAction(() => deletePriceGuideAction({ id: target.id }), {
                    success: "Guide deleted",
                  });
                  setDeleting(null);
                  if (res.ok) router.refresh();
                });
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function CreateGuideForm({
  commodities,
  grades,
  buyingPoints,
  defaultDate,
  onDone,
  onCancel,
}: {
  commodities: Option[];
  grades: GradeOption[];
  buyingPoints: Option[];
  defaultDate: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [pending, startTransition] = useTransition();
  const form = useForm<CreateValues>({
    resolver: zodResolver(createSchema) as unknown as Resolver<CreateValues>,
    defaultValues: {
      commodityId: commodities.length === 1 ? commodities[0].id : "",
      gradeId: "",
      buyingPointId: "",
      guideDate: defaultDate,
      maxPriceNaira: "",
    },
  });
  const commodityId = useWatch({ control: form.control, name: "commodityId" });
  const gradeOptions = grades.filter((g) => g.commodityId === commodityId);

  const onSubmit = form.handleSubmit((v) => {
    startTransition(async () => {
      const res = await runBuyingAction(
        () =>
          createPriceGuideAction({
            commodityId: v.commodityId,
            gradeId: v.gradeId || null,
            buyingPointId: v.buyingPointId || null,
            guideDate: v.guideDate,
            maxPricePerKgKobo: parseNairaToKobo(v.maxPriceNaira) ?? 0,
          }),
        { success: "Price guide set" },
      );
      if (res.ok) onDone();
      else if (res.error === "DUPLICATE") {
        form.setError("guideDate", { message: "A guide for this produce, point and date already exists — edit it instead" });
      }
    });
  });

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
      <Controller
        name="commodityId"
        control={form.control}
        render={({ field, fieldState }) => (
          <Field data-invalid={fieldState.invalid || undefined}>
            <FieldLabel htmlFor="pg-commodity">Commodity</FieldLabel>
            <Select
              value={field.value}
              onValueChange={(v) => {
                field.onChange(v);
                form.setValue("gradeId", "");
              }}
            >
              <SelectTrigger id="pg-commodity" className="h-12 w-full" aria-invalid={fieldState.invalid}>
                <SelectValue placeholder="Pick commodity" />
              </SelectTrigger>
              <SelectContent>
                {commodities.map((c) => (
                  <SelectItem key={c.id} value={c.id} className="min-h-10">
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FieldError errors={[fieldState.error]} />
          </Field>
        )}
      />
      <Controller
        name="gradeId"
        control={form.control}
        render={({ field }) => (
          <Field>
            <FieldLabel htmlFor="pg-grade">Grade</FieldLabel>
            <Select value={field.value || ANY} onValueChange={(v) => field.onChange(v === ANY ? "" : v)} disabled={!commodityId}>
              <SelectTrigger id="pg-grade" className="h-12 w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ANY} className="min-h-10">
                  Any grade
                </SelectItem>
                {gradeOptions.map((g) => (
                  <SelectItem key={g.id} value={g.id} className="min-h-10">
                    {g.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        )}
      />
      <Controller
        name="buyingPointId"
        control={form.control}
        render={({ field }) => (
          <Field>
            <FieldLabel htmlFor="pg-point">Buying point</FieldLabel>
            <Select value={field.value || ANY} onValueChange={(v) => field.onChange(v === ANY ? "" : v)}>
              <SelectTrigger id="pg-point" className="h-12 w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ANY} className="min-h-10">
                  All buying points
                </SelectItem>
                {buyingPoints.map((b) => (
                  <SelectItem key={b.id} value={b.id} className="min-h-10">
                    {b.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        )}
      />
      <div className="grid grid-cols-2 gap-3">
        <Controller
          name="guideDate"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid || undefined} className="col-span-2 sm:col-span-1">
              <FieldLabel htmlFor="pg-date">Date</FieldLabel>
              <Input id="pg-date" type="date" {...field} className="h-12" aria-invalid={fieldState.invalid} />
              <FieldDescription>Applies from this date until a newer guide.</FieldDescription>
              <FieldError errors={[fieldState.error]} />
            </Field>
          )}
        />
        <Controller
          name="maxPriceNaira"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid || undefined} className="col-span-2 sm:col-span-1">
              <FieldLabel htmlFor="pg-price">Max price ₦/kg</FieldLabel>
              <Input
                id="pg-price"
                {...field}
                className="h-12 text-lg"
                inputMode="decimal"
                autoComplete="off"
                aria-invalid={fieldState.invalid}
              />
              <FieldError errors={[fieldState.error]} />
            </Field>
          )}
        />
      </div>
      <DialogFooter>
        <Button type="button" variant="outline" className="h-11 sm:h-9" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" className="h-11 sm:h-9" disabled={pending}>
          {pending ? "Saving…" : "Set guide"}
        </Button>
      </DialogFooter>
    </form>
  );
}

function EditGuideForm({ guide, onDone, onCancel }: { guide: GuideRowView; onDone: () => void; onCancel: () => void }) {
  const [pending, startTransition] = useTransition();
  const form = useForm<EditValues>({
    resolver: zodResolver(editSchema) as unknown as Resolver<EditValues>,
    defaultValues: { guideDate: guide.guideDate, maxPriceNaira: koboToNairaInput(guide.maxPricePerKgKobo) },
  });
  const onSubmit = form.handleSubmit((v) => {
    startTransition(async () => {
      const res = await runBuyingAction(
        () =>
          updatePriceGuideAction({
            id: guide.id,
            guideDate: v.guideDate,
            maxPricePerKgKobo: parseNairaToKobo(v.maxPriceNaira) ?? 0,
          }),
        { success: "Guide updated" },
      );
      if (res.ok) onDone();
      else if (res.error === "DUPLICATE") form.setError("guideDate", { message: "Another guide already covers that date" });
    });
  });
  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3">
        <Controller
          name="guideDate"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid || undefined} className="col-span-2 sm:col-span-1">
              <FieldLabel htmlFor="pge-date">Date</FieldLabel>
              <Input id="pge-date" type="date" {...field} className="h-12" aria-invalid={fieldState.invalid} />
              <FieldError errors={[fieldState.error]} />
            </Field>
          )}
        />
        <Controller
          name="maxPriceNaira"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid || undefined} className="col-span-2 sm:col-span-1">
              <FieldLabel htmlFor="pge-price">Max price ₦/kg</FieldLabel>
              <Input
                id="pge-price"
                {...field}
                className="h-12 text-lg"
                inputMode="decimal"
                autoComplete="off"
                aria-invalid={fieldState.invalid}
              />
              <FieldError errors={[fieldState.error]} />
            </Field>
          )}
        />
      </div>
      <DialogFooter>
        <Button type="button" variant="outline" className="h-11 sm:h-9" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" className="h-11 sm:h-9" disabled={pending}>
          {pending ? "Saving…" : "Save"}
        </Button>
      </DialogFooter>
    </form>
  );
}
