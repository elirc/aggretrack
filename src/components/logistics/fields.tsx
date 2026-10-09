"use client";

import { Controller, type Control, type FieldValues, type Path } from "react-hook-form";

import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

/** Sentinel for "no selection" — Radix Select items cannot use "". */
export const NONE = "__none";

export type Option = { value: string; label: string };

export function TextField<T extends FieldValues>({
  control,
  name,
  label,
  placeholder,
  description,
  inputMode,
  type = "text",
  multiline = false,
  disabled,
}: {
  control: Control<T>;
  name: Path<T>;
  label: string;
  placeholder?: string;
  description?: string;
  inputMode?: "text" | "decimal" | "numeric";
  type?: "text" | "date";
  multiline?: boolean;
  disabled?: boolean;
}) {
  return (
    <Controller
      control={control}
      name={name}
      render={({ field, fieldState }) => {
        const id = `f-${name}`;
        const common = {
          id,
          name: field.name,
          value: typeof field.value === "string" ? field.value : "",
          onBlur: field.onBlur,
          disabled,
          placeholder,
          "aria-invalid": fieldState.invalid,
        };
        return (
          <Field data-invalid={fieldState.invalid || undefined}>
            <FieldLabel htmlFor={id}>{label}</FieldLabel>
            {multiline ? (
              <Textarea {...common} ref={field.ref} rows={2} onChange={(e) => field.onChange(e.target.value)} />
            ) : (
              <Input
                {...common}
                ref={field.ref}
                className="h-11"
                type={type}
                inputMode={inputMode}
                autoComplete="off"
                onChange={(e) => field.onChange(e.target.value)}
              />
            )}
            {description ? <FieldDescription>{description}</FieldDescription> : null}
            <FieldError errors={[fieldState.error]} />
          </Field>
        );
      }}
    />
  );
}

export function SelectField<T extends FieldValues>({
  control,
  name,
  label,
  options,
  placeholder = "Select…",
  noneLabel,
  description,
  disabled,
}: {
  control: Control<T>;
  name: Path<T>;
  label: string;
  options: Option[];
  placeholder?: string;
  /** When set, adds a "none" choice that maps to "". */
  noneLabel?: string;
  description?: string;
  disabled?: boolean;
}) {
  return (
    <Controller
      control={control}
      name={name}
      render={({ field, fieldState }) => {
        const id = `f-${name}`;
        const value = typeof field.value === "string" && field.value !== "" ? field.value : noneLabel ? NONE : "";
        return (
          <Field data-invalid={fieldState.invalid || undefined}>
            <FieldLabel htmlFor={id}>{label}</FieldLabel>
            <Select
              value={value}
              disabled={disabled}
              onValueChange={(v) => field.onChange(v === NONE ? "" : v)}
            >
              <SelectTrigger id={id} className="h-11 w-full" aria-invalid={fieldState.invalid}>
                <SelectValue placeholder={placeholder} />
              </SelectTrigger>
              <SelectContent>
                {noneLabel ? <SelectItem value={NONE}>{noneLabel}</SelectItem> : null}
                {options.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {description ? <FieldDescription>{description}</FieldDescription> : null}
            <FieldError errors={[fieldState.error]} />
          </Field>
        );
      }}
    />
  );
}
