"use client";

import { RouteError } from "@/components/auth/RouteStates";

export default function LoginError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <RouteError error={error} reset={reset} title="Could not load sign in" />;
}
