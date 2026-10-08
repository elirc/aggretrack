"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { authClient } from "@/lib/auth/client";
import { otpSchema } from "@/lib/validation/users";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { authErrorMessage } from "./messages";

interface OtpFormProps {
  phone: string;
  showMockHint: boolean;
  /** Where to go after a successful verification (ignored when onVerified is set). */
  redirectTo?: string;
  onVerified?: () => void;
  onChangePhone?: () => void;
}

function displayPhone(p: string): string {
  return p.startsWith("234") ? `+${p}` : p;
}

export function OtpForm({
  phone,
  showMockHint,
  redirectTo = "/",
  onVerified,
  onChangePhone,
}: OtpFormProps) {
  const router = useRouter();
  const [resending, setResending] = useState(false);
  const form = useForm({
    resolver: zodResolver(otpSchema),
    defaultValues: { code: "" },
  });

  const onSubmit = form.handleSubmit(async ({ code }) => {
    const { error } = await authClient.phoneNumber.verify({ phoneNumber: phone, code });
    if (error) {
      const msg = authErrorMessage(error);
      form.setError("code", { type: "server", message: msg });
      toast.error(msg);
      return;
    }
    toast.success("Phone verified");
    if (onVerified) {
      onVerified();
      return;
    }
    router.replace(redirectTo);
    router.refresh();
  });

  async function resend() {
    setResending(true);
    const { error } = await authClient.phoneNumber.sendOtp({ phoneNumber: phone });
    setResending(false);
    if (error) toast.error(authErrorMessage(error));
    else toast.success("A new code is on its way");
  }

  const err = form.formState.errors.code;

  return (
    <form onSubmit={onSubmit} noValidate>
      <FieldGroup>
        {showMockHint ? (
          <Alert>
            <AlertDescription>
              Dev/mock code: <span className="font-mono font-semibold">123456</span>
            </AlertDescription>
          </Alert>
        ) : null}
        <Field data-invalid={err ? true : undefined}>
          <FieldLabel htmlFor="code">Verification code</FieldLabel>
          <Input
            id="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]*"
            maxLength={6}
            placeholder="6-digit code"
            autoFocus
            className="h-12 text-center font-mono text-xl tracking-[0.4em]"
            aria-invalid={err ? true : undefined}
            {...form.register("code")}
          />
          <FieldDescription>Sent to {displayPhone(phone)}</FieldDescription>
          <FieldError errors={[err]} />
        </Field>
        <Button
          type="submit"
          size="lg"
          className="h-11 w-full"
          disabled={form.formState.isSubmitting}
        >
          {form.formState.isSubmitting ? <Loader2 className="size-4 animate-spin" /> : null}
          Verify
        </Button>
        <div className="flex items-center justify-between text-sm">
          <Button type="button" variant="link" className="px-0" onClick={resend} disabled={resending}>
            {resending ? "Sending…" : "Resend code"}
          </Button>
          {onChangePhone ? (
            <Button type="button" variant="link" className="px-0" onClick={onChangePhone}>
              Change number
            </Button>
          ) : null}
        </div>
      </FieldGroup>
    </form>
  );
}
