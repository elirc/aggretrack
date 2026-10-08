"use client";

// Lives in components/auth because P1-A owns only settings/page.tsx (no
// colocated folder under /settings) — see TASKS.md P1-A ownership.

import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { updateOrgSettingsAction } from "@/actions/org";
import { orgSettingsSchema, type OrgSettingsFormValues } from "@/lib/validation/users";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { actionErrorMessage, applyFieldErrors } from "./messages";

interface OrgSettingsFormProps {
  defaults: OrgSettingsFormValues;
  canEdit: boolean;
}

type TextKey = Exclude<keyof OrgSettingsFormValues, "hidePricesFromWarehouse">;

export function OrgSettingsForm({ defaults, canEdit }: OrgSettingsFormProps) {
  const form = useForm({
    resolver: zodResolver(orgSettingsSchema),
    defaultValues: defaults,
  });
  const { errors, isSubmitting, isDirty } = form.formState;

  const onSubmit = form.handleSubmit(async (values) => {
    const res = await updateOrgSettingsAction(values);
    if (!res.ok) {
      applyFieldErrors(form.setError, res.fieldErrors);
      toast.error(actionErrorMessage(res.error));
      return;
    }
    toast.success("Settings saved");
    form.reset({
      ...res.data,
      oldStockDays: res.data.oldStockDays,
      capacityAlertPercent: res.data.capacityAlertPercent,
    });
  });

  const text = (
    key: TextKey,
    label: string,
    opts: { description?: string; suffix?: string; inputMode?: "decimal" | "numeric" | "text" } = {},
  ) => {
    const err = errors[key];
    return (
      <Field data-invalid={err ? true : undefined}>
        <FieldLabel htmlFor={key}>{label}</FieldLabel>
        <div className="flex items-center gap-2">
          <Input
            id={key}
            inputMode={opts.inputMode ?? "text"}
            className="h-11 text-base"
            disabled={!canEdit}
            aria-invalid={err ? true : undefined}
            {...form.register(key)}
          />
          {opts.suffix ? (
            <span className="shrink-0 text-sm text-muted-foreground">{opts.suffix}</span>
          ) : null}
        </div>
        {opts.description ? <FieldDescription>{opts.description}</FieldDescription> : null}
        <FieldError errors={[err]} />
      </Field>
    );
  };

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Organisation</CardTitle>
          <CardDescription>Your business name as shown on documents.</CardDescription>
        </CardHeader>
        <CardContent>
          <FieldGroup>{text("name", "Organisation name")}</FieldGroup>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Thresholds &amp; alerts</CardTitle>
          <CardDescription>Approvals and warehouse alerts.</CardDescription>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            {text("adjustmentApprovalThresholdKg", "Adjustment approval above", {
              suffix: "kg",
              inputMode: "decimal",
              description: "Stock adjustments larger than this need manager approval.",
            })}
            {text("lowStockThresholdKg", "Low stock alert below", {
              suffix: "kg",
              inputMode: "decimal",
            })}
            {text("oldStockDays", "Old stock after", { suffix: "days", inputMode: "numeric" })}
            {text("capacityAlertPercent", "Warehouse near capacity at", {
              suffix: "%",
              inputMode: "numeric",
            })}
          </FieldGroup>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Invoices &amp; privacy</CardTitle>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            {text("invoiceTaxPercent", "Invoice tax", {
              suffix: "%",
              inputMode: "decimal",
              description: "0 keeps the tax line off (default).",
            })}
            <Controller
              control={form.control}
              name="hidePricesFromWarehouse"
              render={({ field }) => (
                <Field orientation="horizontal">
                  <FieldContent>
                    <FieldLabel htmlFor="hidePricesFromWarehouse">
                      Hide prices from warehouse keepers
                    </FieldLabel>
                    <FieldDescription>
                      Warehouse keepers will not see costs, prices or stock values.
                    </FieldDescription>
                  </FieldContent>
                  <Switch
                    id="hidePricesFromWarehouse"
                    checked={field.value}
                    onCheckedChange={field.onChange}
                    disabled={!canEdit}
                  />
                </Field>
              )}
            />
          </FieldGroup>
        </CardContent>
      </Card>

      {canEdit ? (
        <div className="sticky bottom-20 z-10 md:static">
          <Button
            type="submit"
            size="lg"
            className="h-11 w-full md:w-auto"
            disabled={isSubmitting || !isDirty}
          >
            {isSubmitting ? <Loader2 className="size-4 animate-spin" /> : null}
            Save settings
          </Button>
        </div>
      ) : null}
    </form>
  );
}
