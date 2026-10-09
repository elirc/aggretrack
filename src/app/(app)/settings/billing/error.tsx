"use client";

import { RouteError } from "@/components/auth/RouteStates";

export default function BillingError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <RouteError error={error} reset={reset} title="Could not load billing" />;
}
