"use client";

import { useTransition, type ReactNode } from "react";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import type { z } from "zod";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import type { ActionResult } from "@/lib/authz/guard";

/**
 * Config-driven form used by the master-data tabs, the onboarding wizard and
 * the platform plans page. react-hook-form + zodResolver over the SAME zod
 * schemas the server actions parse with.
 */

export type FormValues = Record<string, string | boolean | number | null | undefined>;

export type FieldSpec =
  | {
      name: string;
      label: string;
      kind: "text" | "kg" | "number";
      placeholder?: string;
      description?: string;
      inputMode?: "text" | "decimal" | "numeric" | "tel";
    }
  | { name: string; label: string; kind: "switch"; description?: string }
  | {
      name: string;
      label: string;
      kind: "select";
      options: { value: string; label: string }[];
      placeholder?: string;
      description?: string;
    };

/** Any server action produced by orgAction/platformAction. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyAction = (raw: any) => Promise<ActionResult<unknown>>;

export function actionErrorMessage(code: string): string {
  switch (code) {
    case "DUPLICATE":
      return "That name or code already exists.";
    case "NOT_FOUND":
      return "That record no longer exists. Refresh and try again.";
    case "IN_USE":
      return "It is in use and can't be removed.";
    case "FORBIDDEN":
      return "You don't have permission to do that.";
    case "READ_ONLY":
      return "Subscription inactive — your organisation is read only.";
    case "VALIDATION":
      return "Please check the highlighted fields.";
    case "UNAUTHENTICATED":
      return "Your session has expired. Please sign in again.";
    case "NO_SUBSCRIPTION":
      return "This organisation has no subscription yet.";
    default:
      return "Something went wrong. Please try again.";
  }
}

/** Call an action, toast on failure, return data or null. */
export async function runAction<R>(
  action: (raw: never) => Promise<ActionResult<R>>,
  input: unknown,
  success?: string,
): Promise<R | null> {
  try {
    const res = await (action as unknown as (raw: unknown) => Promise<ActionResult<R>>)(input);
    if (res.ok) {
      if (success) toast.success(success);
      return res.data;
    }
    toast.error(actionErrorMessage(res.error));
    return null;
  } catch {
    toast.error(actionErrorMessage("INTERNAL"));
    return null;
  }
}

export function formatKg(kg: string | null | undefined): string {
  if (kg === null || kg === undefined || kg === "") return "—";
  const trimmed = kg.includes(".") ? kg.replace(/\.?0+$/, "") : kg;
  const [int, frac] = trimmed.split(".");
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${frac ? `${grouped}.${frac}` : grouped} kg`;
}

/** "100.000" → "100" for form defaults. */
export function kgForInput(kg: string | null | undefined): string {
  if (!kg) return "";
  return kg.includes(".") ? kg.replace(/\.?0+$/, "") : kg;
}

export function EntityForm({
  fields,
  schema,
  defaultValues,
  action,
  successMessage,
  submitLabel = "Save",
  onSuccess,
  resetOnSuccess = false,
  secondary,
  transform,
}: {
  fields: FieldSpec[];
  schema: z.ZodType;
  defaultValues: FormValues;
  action: AnyAction;
  successMessage?: string;
  submitLabel?: string;
  onSuccess?: (data: unknown) => void;
  resetOnSuccess?: boolean;
  /** Extra button(s) shown next to submit (e.g. Cancel / Skip). */
  secondary?: ReactNode;
  /** Map parsed form values to the action payload (e.g. naira → kobo). */
  transform?: (values: FormValues) => unknown;
}) {
  const [pending, startTransition] = useTransition();
  const form = useForm<FormValues, unknown, FormValues>({
    resolver: zodResolver(schema as unknown as z.ZodType<FormValues, FormValues>),
    defaultValues,
  });

  const onSubmit = form.handleSubmit((values) => {
    startTransition(async () => {
      let res: ActionResult<unknown>;
      try {
        res = await action(transform ? transform(values) : values);
      } catch {
        toast.error(actionErrorMessage("INTERNAL"));
        return;
      }
      if (res.ok) {
        if (successMessage) toast.success(successMessage);
        if (resetOnSuccess) form.reset(defaultValues);
        onSuccess?.(res.data);
        return;
      }
      if (res.fieldErrors) {
        for (const [name, msgs] of Object.entries(res.fieldErrors)) {
          if (msgs?.[0]) form.setError(name, { message: msgs[0] });
        }
      }
      if (res.error === "DUPLICATE") {
        const first = fields.find((f) => f.kind === "text");
        if (first) form.setError(first.name, { message: "Already exists" });
      }
      toast.error(actionErrorMessage(res.error));
    });
  });

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
      <FieldGroup className="gap-4">
        {fields.map((spec) => (
          <Controller
            key={spec.name}
            name={spec.name}
            control={form.control}
            render={({ field, fieldState }) => {
              const id = `f-${spec.name}`;
              if (spec.kind === "switch") {
                return (
                  <Field orientation="horizontal" data-invalid={fieldState.invalid || undefined}>
                    <Switch
                      id={id}
                      checked={field.value === true}
                      onCheckedChange={(v) => field.onChange(v)}
                    />
                    <div className="flex flex-col">
                      <FieldLabel htmlFor={id}>{spec.label}</FieldLabel>
                      {spec.description ? <FieldDescription>{spec.description}</FieldDescription> : null}
                    </div>
                  </Field>
                );
              }
              if (spec.kind === "select") {
                return (
                  <Field data-invalid={fieldState.invalid || undefined}>
                    <FieldLabel htmlFor={id}>{spec.label}</FieldLabel>
                    <Select
                      value={typeof field.value === "string" ? field.value : ""}
                      onValueChange={(v) => field.onChange(v)}
                    >
                      <SelectTrigger id={id} className="h-11 w-full" aria-invalid={fieldState.invalid}>
                        <SelectValue placeholder={spec.placeholder ?? "Select…"} />
                      </SelectTrigger>
                      <SelectContent>
                        {spec.options.map((o) => (
                          <SelectItem key={o.value} value={o.value}>
                            {o.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {spec.description ? <FieldDescription>{spec.description}</FieldDescription> : null}
                    <FieldError errors={[fieldState.error]} />
                  </Field>
                );
              }
              const isNumber = spec.kind === "number";
              return (
                <Field data-invalid={fieldState.invalid || undefined}>
                  <FieldLabel htmlFor={id}>{spec.label}</FieldLabel>
                  <Input
                    id={id}
                    name={field.name}
                    ref={field.ref}
                    onBlur={field.onBlur}
                    className="h-11"
                    value={field.value === null || field.value === undefined ? "" : String(field.value)}
                    onChange={(e) => {
                      const v = e.target.value;
                      if (isNumber) field.onChange(v === "" ? undefined : Number(v));
                      else field.onChange(v);
                    }}
                    inputMode={
                      spec.inputMode ?? (spec.kind === "kg" ? "decimal" : isNumber ? "numeric" : "text")
                    }
                    type="text"
                    autoComplete="off"
                    placeholder={spec.placeholder}
                    aria-invalid={fieldState.invalid}
                  />
                  {spec.description ? <FieldDescription>{spec.description}</FieldDescription> : null}
                  <FieldError errors={[fieldState.error]} />
                </Field>
              );
            }}
          />
        ))}
      </FieldGroup>
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        {secondary}
        <Button type="submit" className="h-11 sm:h-9" disabled={pending}>
          {pending ? "Saving…" : submitLabel}
        </Button>
      </div>
    </form>
  );
}
