"use client";

import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { authClient } from "@/lib/auth/client";
import { phoneLoginSchema } from "@/lib/validation/users";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { authErrorMessage } from "./messages";

interface PhoneLoginFormProps {
  /** Called with the normalised phone after the OTP was sent. Default: go to /verify. */
  onSent?: (phone: string) => void;
  submitLabel?: string;
  defaultPhone?: string;
}

export function PhoneLoginForm({
  onSent,
  submitLabel = "Send code",
  defaultPhone = "",
}: PhoneLoginFormProps) {
  const router = useRouter();
  const form = useForm({
    resolver: zodResolver(phoneLoginSchema),
    defaultValues: { phone: defaultPhone },
  });

  const onSubmit = form.handleSubmit(async ({ phone }) => {
    const { error } = await authClient.phoneNumber.sendOtp({ phoneNumber: phone });
    if (error) {
      toast.error(authErrorMessage(error));
      return;
    }
    toast.success("Code sent by SMS");
    if (onSent) onSent(phone);
    else router.push(`/verify?phone=${encodeURIComponent(phone)}`);
  });

  const err = form.formState.errors.phone;

  return (
    <form onSubmit={onSubmit} noValidate>
      <FieldGroup>
        <Field data-invalid={err ? true : undefined}>
          <FieldLabel htmlFor="phone">Phone number</FieldLabel>
          <Input
            id="phone"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            placeholder="0803 123 4567"
            className="h-11 text-base"
            aria-invalid={err ? true : undefined}
            {...form.register("phone")}
          />
          <FieldDescription>We will send a 6-digit code by SMS.</FieldDescription>
          <FieldError errors={[err]} />
        </Field>
        <Button
          type="submit"
          size="lg"
          className="h-11 w-full"
          disabled={form.formState.isSubmitting}
        >
          {form.formState.isSubmitting ? <Loader2 className="size-4 animate-spin" /> : null}
          {submitLabel}
        </Button>
      </FieldGroup>
    </form>
  );
}
