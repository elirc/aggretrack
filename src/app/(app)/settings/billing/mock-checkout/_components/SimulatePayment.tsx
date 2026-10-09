"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";

/** Posts the synthetic Paystack events to the real webhook route, then returns to billing. */
export function SimulatePayment({ bodies, signature }: { bodies: string[]; signature: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function simulate() {
    setPending(true);
    try {
      for (const body of bodies) {
        const res = await fetch("/api/webhooks/paystack", {
          method: "POST",
          headers: { "content-type": "application/json", "x-paystack-signature": signature },
          body,
        });
        if (!res.ok) throw new Error(`Webhook answered ${res.status}`);
      }
      router.push("/settings/billing?checkout=success");
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Simulated payment failed");
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-2 sm:flex-row">
      <Button className="h-11" onClick={simulate} disabled={pending}>
        {pending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
        Simulate successful payment
      </Button>
      <Button variant="outline" className="h-11" asChild>
        <Link href="/settings/billing">Cancel</Link>
      </Button>
    </div>
  );
}
