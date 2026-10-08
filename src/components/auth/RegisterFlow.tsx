"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { authClient } from "@/lib/auth/client";
import { initialiseOrganisationAction } from "@/actions/org";
import { registerOrgSchema, slugify } from "@/lib/validation/users";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { PhoneLoginForm } from "./PhoneLoginForm";
import { OtpForm } from "./OtpForm";
import { actionErrorMessage, authErrorMessage } from "./messages";

type Step = "phone" | "otp" | "details";

interface RegisterFlowProps {
  /** Already signed in (e.g. verified earlier) but without an organisation. */
  signedIn: boolean;
  defaultName: string;
  showMockHint: boolean;
}

const STEP_TITLES: Record<Step, { title: string; description: string }> = {
  phone: { title: "Create your account", description: "Step 1 of 3 — your phone number" },
  otp: { title: "Verify your phone", description: "Step 2 of 3 — enter the code we sent" },
  details: { title: "Your business", description: "Step 3 of 3 — name and organisation" },
};

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 6);
}

export function RegisterFlow({ signedIn, defaultName, showMockHint }: RegisterFlowProps) {
  const [step, setStep] = useState<Step>(signedIn ? "details" : "phone");
  const [phone, setPhone] = useState("");
  const { title, description } = STEP_TITLES[step];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {step === "phone" ? (
          <>
            <PhoneLoginForm
              submitLabel="Send code"
              defaultPhone={phone}
              onSent={(p) => {
                setPhone(p);
                setStep("otp");
              }}
            />
            <p className="text-center text-sm text-muted-foreground">
              Already registered?{" "}
              <Link href="/login" className="font-medium text-primary underline-offset-4 hover:underline">
                Sign in
              </Link>
            </p>
          </>
        ) : null}
        {step === "otp" ? (
          <OtpForm
            phone={phone}
            showMockHint={showMockHint}
            onVerified={() => setStep("details")}
            onChangePhone={() => setStep("phone")}
          />
        ) : null}
        {step === "details" ? <OrgDetailsForm defaultName={defaultName} /> : null}
      </CardContent>
    </Card>
  );
}

function OrgDetailsForm({ defaultName }: { defaultName: string }) {
  const router = useRouter();
  const form = useForm({
    resolver: zodResolver(registerOrgSchema),
    defaultValues: { userName: defaultName, orgName: "" },
  });
  const { errors, isSubmitting } = form.formState;

  const onSubmit = form.handleSubmit(async ({ userName, orgName }) => {
    const upd = await authClient.updateUser({ name: userName });
    if (upd.error) {
      toast.error(authErrorMessage(upd.error));
      return;
    }

    const created = await authClient.organization.create({
      name: orgName,
      slug: `${slugify(orgName)}-${randomSuffix()}`,
    });
    if (created.error || !created.data) {
      toast.error(authErrorMessage(created.error));
      return;
    }

    const active = await authClient.organization.setActive({
      organizationId: created.data.id,
    });
    if (active.error) {
      toast.error(authErrorMessage(active.error));
      return;
    }

    const init = await initialiseOrganisationAction({});
    if (!init.ok) {
      toast.error(actionErrorMessage(init.error));
      return;
    }

    toast.success("Organisation created — 14-day free trial started");
    router.replace("/onboarding");
    router.refresh();
  });

  return (
    <form onSubmit={onSubmit} noValidate>
      <FieldGroup>
        <Field data-invalid={errors.userName ? true : undefined}>
          <FieldLabel htmlFor="userName">Your name</FieldLabel>
          <Input
            id="userName"
            autoComplete="name"
            className="h-11 text-base"
            aria-invalid={errors.userName ? true : undefined}
            {...form.register("userName")}
          />
          <FieldError errors={[errors.userName]} />
        </Field>
        <Field data-invalid={errors.orgName ? true : undefined}>
          <FieldLabel htmlFor="orgName">Organisation name</FieldLabel>
          <Input
            id="orgName"
            autoComplete="organization"
            placeholder="e.g. Gombe Grains Ltd"
            className="h-11 text-base"
            aria-invalid={errors.orgName ? true : undefined}
            {...form.register("orgName")}
          />
          <FieldError errors={[errors.orgName]} />
        </Field>
        <Button type="submit" size="lg" className="h-11 w-full" disabled={isSubmitting}>
          {isSubmitting ? <Loader2 className="size-4 animate-spin" /> : null}
          Create organisation
        </Button>
      </FieldGroup>
    </form>
  );
}
