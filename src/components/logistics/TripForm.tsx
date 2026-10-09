"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Controller, useForm, useWatch, type Path } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";

import { createTripAction, updateTripAction } from "@/actions/trips";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { tripInput, type TripDirection } from "@/lib/validation/logistics";

import { SelectField, TextField, type Option } from "./fields";
import { actionErrorMessage } from "./run-action";
import { nairaToKobo } from "./utils";

export type TripFormValues = {
  direction: TripDirection;
  vehicleId: string;
  driverId: string;
  origin: string;
  destination: string;
  tripDate: string;
  costNaira: string;
  note: string;
};

/** Form field ← payload field, for mapping zod / server errors back onto inputs. */
const FIELD_FOR: Record<string, keyof TripFormValues> = { costKobo: "costNaira" };

function toPayload(v: TripFormValues) {
  return {
    direction: v.direction,
    vehicleId: v.vehicleId || null,
    driverId: v.driverId || null,
    origin: v.origin,
    destination: v.destination,
    tripDate: v.tripDate,
    costKobo: v.costNaira.trim() === "" ? 0 : (nairaToKobo(v.costNaira) ?? -1),
    note: v.note,
  };
}

function withoutDirection(p: ReturnType<typeof toPayload>) {
  const { direction: _direction, ...rest } = p;
  void _direction;
  return rest;
}

/**
 * Form schema = UI strings, then the SAME shared tripInput schema applied to
 * the converted payload so client validation mirrors the server exactly.
 */
const tripFormSchema = z
  .object({
    direction: z.enum(["inbound", "outbound"]),
    vehicleId: z.string(),
    driverId: z.string(),
    origin: z.string(),
    destination: z.string(),
    tripDate: z.string(),
    costNaira: z.string(),
    note: z.string(),
  })
  .superRefine((v, ctx) => {
    if (v.costNaira.trim() !== "" && nairaToKobo(v.costNaira) === null) {
      ctx.addIssue({ code: "custom", path: ["costNaira"], message: "Enter an amount in naira, e.g. 45000 or 45000.50" });
      return;
    }
    const r = tripInput.safeParse(toPayload(v));
    if (!r.success) {
      for (const issue of r.error.issues) {
        const key = String(issue.path[0] ?? "note");
        ctx.addIssue({ code: "custom", path: [FIELD_FOR[key] ?? key], message: issue.message });
      }
    }
  });

export function TripForm({
  mode,
  tripId,
  defaults,
  vehicles,
  drivers,
  canWrite,
}: {
  mode: "create" | "edit";
  tripId?: string;
  defaults: TripFormValues;
  vehicles: Option[];
  drivers: Option[];
  canWrite: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const form = useForm<TripFormValues>({ resolver: zodResolver(tripFormSchema), defaultValues: defaults });
  const disabled = !canWrite || pending;
  const direction = useWatch({ control: form.control, name: "direction" });

  const onSubmit = form.handleSubmit((values) => {
    startTransition(async () => {
      const payload = toPayload(values);
      try {
        const res =
          mode === "create"
            ? await createTripAction(payload)
            : await updateTripAction({ ...withoutDirection(payload), id: tripId ?? "" });
        if (!res.ok) {
          for (const [name, msgs] of Object.entries(res.fieldErrors ?? {})) {
            const field = (FIELD_FOR[name] ?? name) as Path<TripFormValues>;
            if (msgs?.[0]) form.setError(field, { message: msgs[0] });
          }
          toast.error(actionErrorMessage(res.error));
          return;
        }
        if (mode === "create") {
          const data = res.data as { id: string; tripNumber: string };
          toast.success(`Trip ${data.tripNumber} created`);
          router.push(`/trips/${data.id}`);
        } else {
          toast.success("Trip saved");
          form.reset(values);
          router.refresh();
        }
      } catch {
        toast.error(actionErrorMessage("INTERNAL"));
      }
    });
  });

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
      <FieldGroup className="gap-4">
        {mode === "create" ? (
          <Controller
            control={form.control}
            name="direction"
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid || undefined}>
                <FieldLabel>Direction</FieldLabel>
                <RadioGroup
                  value={field.value}
                  onValueChange={(v) => field.onChange(v as TripDirection)}
                  className="grid grid-cols-2 gap-2"
                  disabled={disabled}
                >
                  {(["inbound", "outbound"] as const).map((d) => (
                    <label
                      key={d}
                      className="flex min-h-11 cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm has-data-checked:border-primary"
                    >
                      <RadioGroupItem value={d} />
                      <span>
                        <span className="font-medium capitalize">{d}</span>
                        <span className="block text-xs text-muted-foreground">
                          {d === "inbound" ? "Collection → purchases" : "Delivery → dispatches"}
                        </span>
                      </span>
                    </label>
                  ))}
                </RadioGroup>
                <FieldDescription>Direction can&apos;t be changed after the trip is created.</FieldDescription>
                <FieldError errors={[fieldState.error]} />
              </Field>
            )}
          />
        ) : (
          <div className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">Direction</span>
            <DirectionBadge direction={defaults.direction} />
            <span className="text-xs text-muted-foreground">(fixed)</span>
          </div>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField control={form.control} name="tripDate" label="Date" type="date" disabled={disabled} />
          <TextField
            control={form.control}
            name="costNaira"
            label="Trip cost (₦)"
            inputMode="decimal"
            placeholder="0"
            description={direction === "inbound" ? "Shared into lot landed cost by weight." : undefined}
            disabled={disabled}
          />
          <SelectField
            control={form.control}
            name="vehicleId"
            label="Vehicle"
            options={vehicles}
            noneLabel="No vehicle"
            disabled={disabled}
          />
          <SelectField
            control={form.control}
            name="driverId"
            label="Driver"
            options={drivers}
            noneLabel="No driver"
            disabled={disabled}
          />
          <TextField control={form.control} name="origin" label="Origin" placeholder="e.g. Funtua" disabled={disabled} />
          <TextField
            control={form.control}
            name="destination"
            label="Destination"
            placeholder="e.g. Kano warehouse"
            disabled={disabled}
          />
        </div>
        <TextField control={form.control} name="note" label="Note" multiline disabled={disabled} />
      </FieldGroup>
      {canWrite ? (
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          {mode === "create" ? (
            <Button type="button" variant="outline" className="h-11 sm:h-9" onClick={() => router.push("/trips")}>
              Cancel
            </Button>
          ) : null}
          <Button type="submit" className="h-11 sm:h-9" disabled={pending}>
            {pending ? "Saving…" : mode === "create" ? "Create trip" : "Save changes"}
          </Button>
        </div>
      ) : null}
    </form>
  );
}

export function DirectionBadge({ direction }: { direction: TripDirection }) {
  return (
    <Badge variant={direction === "inbound" ? "secondary" : "outline"} className="capitalize">
      {direction === "inbound" ? "↓ Inbound" : "↑ Outbound"}
    </Badge>
  );
}
