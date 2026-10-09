"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";

import { startCheckoutAction } from "@/actions/billing";
import { actionErrorMessage } from "@/components/auth/messages";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";

const MESSAGES: Record<string, string> = {
  ALREADY_ACTIVE: "Your subscription is already active.",
  NO_EMAIL: "Add an email address to your profile before subscribing.",
  NO_SUBSCRIPTION: "This organisation has no subscription record.",
};

export function PlanPicker({
  plans,
  defaultPlanId,
}: {
  plans: { id: string; name: string; price: string; userLimit: number }[];
  defaultPlanId: string;
}) {
  const [planId, setPlanId] = useState(
    plans.some((p) => p.id === defaultPlanId) ? defaultPlanId : (plans[0]?.id ?? ""),
  );
  const [pending, startTransition] = useTransition();

  function subscribe() {
    startTransition(async () => {
      const res = await startCheckoutAction({ planId });
      if (!res.ok) {
        toast.error(MESSAGES[res.error] ?? actionErrorMessage(res.error));
        return;
      }
      // Hosted checkout (Paystack) or the mock checkout page.
      window.location.assign(res.data.checkoutUrl);
    });
  }

  return (
    <div className="space-y-4">
      <RadioGroup value={planId} onValueChange={setPlanId} aria-label="Plan">
        {plans.map((p) => (
          <Label
            key={p.id}
            htmlFor={`plan-${p.id}`}
            className="flex min-h-12 cursor-pointer items-center gap-3 rounded-lg border p-3 has-[[data-state=checked]]:border-primary"
          >
            <RadioGroupItem id={`plan-${p.id}`} value={p.id} />
            <span className="flex-1">
              <span className="block font-medium">{p.name}</span>
              <span className="block text-sm text-muted-foreground">
                {p.price} / month · up to {p.userLimit} users
              </span>
            </span>
          </Label>
        ))}
      </RadioGroup>
      <Button className="h-11 w-full sm:w-auto" onClick={subscribe} disabled={pending || !planId}>
        {pending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
        Subscribe
      </Button>
    </div>
  );
}
